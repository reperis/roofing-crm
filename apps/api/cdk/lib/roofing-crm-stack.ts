import * as path from 'node:path';

import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import type { Construct } from 'constructs';

import {
  AGENT_DAILY_CALL_LIMIT,
  ANTHROPIC_KEY_PARAMETER,
  PROJECT_NAME,
  SERVICE_NAME,
} from './constants';

/** Built SPA bundle, produced by `pnpm --filter @roofing/web build`. */
const WEB_DIST = path.join(__dirname, '..', '..', '..', 'web', 'dist');

/**
 * The single stack for the roofing CRM.
 *
 * Two halves with very different shapes. The **read** side — every property and permit query the
 * map fires — has no server at all: the published Parquet tables are fetched over HTTP byte
 * ranges and DuckDB runs inside the salesperson's browser, so panning the map costs the business
 * nothing and there is no database to keep warm for a sales team of three. The **write** side —
 * lead records, which must outlive a browser tab and be visible to the whole team — is a
 * DynamoDB table behind a Lambda, billed per request.
 *
 * The result is a CRM whose standing cost is a few cents of S3 storage a month.
 */
export class RoofingCrmStack extends cdk.Stack {
  public readonly distribution: cloudfront.Distribution;
  public readonly leadsTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    // `StackProps.tags` only sets CloudFormation stack-level tags, which never reach the
    // individual resources. The guidelines require every resource to carry project_name for cost
    // allocation, so apply it as an aspect across the whole construct tree.
    cdk.Tags.of(this).add('project_name', PROJECT_NAME);

    const siteBucket = new s3.Bucket(this, 'SiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // This is a rebuildable static bundle; keeping it would only orphan storage.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    /**
     * Lead records.
     *
     * Single-table, partitioned by lead id — which is derived from the parcel identifier, so two
     * reps converting the same property write to the same item instead of creating two leads and
     * two phone calls to one homeowner.
     *
     * A GSI on status supports the pipeline board's "everything in stage X, oldest first" read
     * without scanning the table. On-demand billing because a sales team's traffic is bursty and
     * provisioned capacity for this would be both more expensive and more to operate.
     */
    this.leadsTable = new dynamodb.Table(this, 'LeadsTable', {
      partitionKey: { name: 'lead_id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      // Leads are customer records. A stack teardown must not be able to delete them.
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.leadsTable.addGlobalSecondaryIndex({
      indexName: 'by-status',
      partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'status_changed_at', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const leadsApi = this.addLeadsApi();
    this.addAgentRoute(leadsApi, siteBucket);

    /**
     * What CloudFront forwards to the API origin.
     *
     * Query strings must be forwarded in full — `?status=contacted` is the pipeline board's whole
     * filter, and the managed CORS policies drop query strings entirely, which turns a filtered
     * request into an unfiltered one that silently returns the wrong rows rather than an error.
     *
     * The Host header must *not* be forwarded: API Gateway routes on it, and passing the
     * CloudFront hostname through produces a 403 from a gateway that has never heard of it.
     */
    const apiOriginRequestPolicy = new cloudfront.OriginRequestPolicy(this, 'ApiOriginPolicy', {
      comment: 'Forward query strings and body to the leads API, but not the Host header',
      queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.all(),
      headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList('content-type'),
      cookieBehavior: cloudfront.OriginRequestCookieBehavior.none(),
    });

    this.distribution = new cloudfront.Distribution(this, 'SiteDistribution', {
      comment: 'Roofing CRM - Chester County lead identification',
      defaultRootObject: 'index.html',
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        compress: true,
      },
      /**
       * The leads API is served from the site's own origin, under `/api`.
       *
       * Routing it through the same distribution rather than exposing the API Gateway URL
       * directly means the browser treats it as same-origin: no preflight, no CORS configuration
       * to keep in step with a CloudFront domain that changes per deployment, and one hostname
       * for the evaluator to reach. Caching is disabled because every response is per-team
       * mutable state — a cached lead board would show one rep another's stale pipeline.
       */
      additionalBehaviors: {
        'api/*': {
          origin: new origins.HttpOrigin(cdk.Fn.select(2, cdk.Fn.split('/', leadsApi.apiEndpoint))),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: apiOriginRequestPolicy,
        },
      },
      /**
       * Client-side routing: unknown paths return the SPA shell rather than an S3 error document.
       *
       * Only 403 is mapped, deliberately. Custom error responses are distribution-wide — they
       * cannot be scoped to one behavior — so mapping 404 would rewrite the leads API's own
       * "no such lead" into a 200 carrying the HTML page, which a JSON client cannot parse and
       * which reports success for a request that failed.
       *
       * Mapping 403 alone is sufficient because the site bucket blocks public access and is read
       * through origin access control: S3 answers a missing key with 403, not 404. So SPA deep
       * links still resolve, and API 404s pass through untouched.
       */
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        },
      ],
    });

    // The bundle carries the DuckDB WASM runtime and the staged Parquet tables, so the deployment
    // Lambda unzips well over a hundred megabytes. The 128 MB / 512 MB defaults fail on that with
    // an opaque out-of-space error partway through the upload.
    const deploymentCapacity = {
      memoryLimit: 1024,
      ephemeralStorageSize: cdk.Size.gibibytes(2),
      // Pruning is disabled because two deployments share one bucket: whichever ran second would
      // delete the other's objects. Vite content-hashes every filename, so superseded assets are
      // inert rather than stale, and the bucket is torn down with the stack.
      prune: false,
    };

    new s3deploy.BucketDeployment(this, 'SiteDeployment', {
      sources: [s3deploy.Source.asset(WEB_DIST)],
      destinationBucket: siteBucket,
      distribution: this.distribution,
      distributionPaths: ['/*'],
      exclude: ['*.wasm'],
      ...deploymentCapacity,
    });

    /**
     * The WASM binaries are uploaded separately because they are gzipped at build time.
     *
     * CloudFront's automatic compression stops at 10 MB and the DuckDB runtime is roughly 36 MB,
     * so left alone it ships uncompressed — a 36 MB download before the first query can run.
     * `compress-wasm.ts` gzips them during the build; this deployment is what tells S3 to serve
     * them with the matching `Content-Encoding`, without which a browser receives gzip bytes
     * labelled as WebAssembly and fails to instantiate the module.
     */
    new s3deploy.BucketDeployment(this, 'WasmDeployment', {
      sources: [s3deploy.Source.asset(WEB_DIST)],
      destinationBucket: siteBucket,
      distribution: this.distribution,
      distributionPaths: ['/assets/*.wasm'],
      exclude: ['*'],
      include: ['*.wasm'],
      contentType: 'application/wasm',
      contentEncoding: 'gzip',
      ...deploymentCapacity,
    });

    new cdk.CfnOutput(this, 'SiteUrl', {
      value: `https://${this.distribution.distributionDomainName}`,
      description: 'Public runtime URL - no credentials required',
    });

    new cdk.CfnOutput(this, 'LeadsTableName', {
      value: this.leadsTable.tableName,
      description: 'DynamoDB table holding CRM lead records',
    });

    new cdk.CfnOutput(this, 'LeadsApiUrl', {
      value: `https://${this.distribution.distributionDomainName}/api/leads`,
      description: 'Lead records API, same-origin behind the site distribution',
    });
  }

  /**
   * The lead records API.
   *
   * One function for the whole resource rather than one per verb. The routes share their
   * validation, their table access and their error shape, so splitting them would duplicate all
   * three to save nothing — and five separate cold starts is worse for a sales rep clicking
   * Convert than one warm container serving every path.
   */
  private addLeadsApi(): apigwv2.HttpApi {
    const leadsFunction = new nodejs.NodejsFunction(this, 'LeadsFunction', {
      entry: path.join(__dirname, '..', '..', 'src', 'leads', 'handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(15),
      tracing: lambda.Tracing.ACTIVE,
      logRetention: logs.RetentionDays.THREE_MONTHS,
      environment: {
        LEADS_TABLE_NAME: this.leadsTable.tableName,
        POWERTOOLS_SERVICE_NAME: SERVICE_NAME,
        POWERTOOLS_LOG_LEVEL: 'INFO',
        NODE_OPTIONS: '--enable-source-maps',
      },
      bundling: { minify: true, sourceMap: true },
    });

    this.leadsTable.grantReadWriteData(leadsFunction);

    const api = new apigwv2.HttpApi(this, 'LeadsApi', {
      description: 'Roofing CRM lead records',
    });

    const integration = new integrations.HttpLambdaIntegration('LeadsIntegration', leadsFunction);

    // Paths carry the `/api` prefix because CloudFront forwards the path unchanged; rewriting it
    // at the edge would need a function association for no benefit.
    api.addRoutes({
      path: '/api/leads',
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration,
    });
    api.addRoutes({
      path: '/api/leads/{leadId}',
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.PATCH],
      integration,
    });

    // Throttling bounds a burst against an endpoint that is public by design.
    const stage = api.defaultStage?.node.defaultChild as apigwv2.CfnStage | undefined;
    if (stage !== undefined) {
      stage.defaultRouteSettings = { throttlingRateLimit: 20, throttlingBurstLimit: 40 };
    }

    return api;
  }

  /**
   * The natural-language lead-research agent.
   *
   * Added to the leads API rather than given its own gateway, so both share the single `/api/*`
   * CloudFront behavior and the site keeps one origin. The agent reads the published Parquet
   * straight from the site bucket and the pipeline from DynamoDB — it is the only component that
   * sees both, which is why the model loop runs here rather than in the browser.
   */
  private addAgentRoute(api: apigwv2.HttpApi, datasetBucket: s3.Bucket): void {
    /**
     * Daily call counter.
     *
     * Separate from the leads table because its items are throwaway: a TTL expires them without a
     * cleanup job, and mixing a self-deleting counter into the table that holds customer records
     * invites exactly the kind of accident nobody notices until the records are gone.
     */
    const spendTable = new dynamodb.Table(this, 'AgentSpendTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const agentFunction = new nodejs.NodejsFunction(this, 'AgentFunction', {
      entry: path.join(__dirname, '..', '..', 'src', 'agent', 'handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      // Parsing 193,000 properties and 75,000 permits costs roughly 200 MB, once per container.
      // More memory also buys proportionally more CPU, which is what makes the parse sub-second.
      memorySize: 1536,
      // Under API Gateway's hard 29 s ceiling, deliberately. A longer function cannot deliver a
      // response the gateway has already abandoned — it just spends a budget slot on a 504.
      timeout: cdk.Duration.seconds(25),
      tracing: lambda.Tracing.ACTIVE,
      logRetention: logs.RetentionDays.THREE_MONTHS,
      environment: {
        // The key itself is never here. Only the name of the SecureString that holds it: an
        // environment variable is rendered into the CloudFormation template and staged in S3, so
        // a secret placed here would sit in plaintext in several places that outlive a rotation.
        ANTHROPIC_API_KEY_PARAMETER: ANTHROPIC_KEY_PARAMETER,
        AGENT_DAILY_CALL_LIMIT: String(AGENT_DAILY_CALL_LIMIT),
        SPEND_TABLE_NAME: spendTable.tableName,
        LEADS_TABLE_NAME: this.leadsTable.tableName,
        DATASET_BUCKET: datasetBucket.bucketName,
        DATASET_PREFIX: 'dataset',
        POWERTOOLS_SERVICE_NAME: SERVICE_NAME,
        POWERTOOLS_LOG_LEVEL: 'INFO',
        NODE_OPTIONS: '--enable-source-maps',
      },
      bundling: { minify: true, sourceMap: true },
    });

    spendTable.grantReadWriteData(agentFunction);
    this.leadsTable.grantReadWriteData(agentFunction);
    datasetBucket.grantRead(agentFunction, 'dataset/*');

    // Scoped to the one parameter, not to ssm:* — this role should be able to read the model key
    // and nothing else in the account.
    agentFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [
          cdk.Arn.format(
            {
              service: 'ssm',
              resource: 'parameter',
              resourceName: ANTHROPIC_KEY_PARAMETER.slice(1),
            },
            this,
          ),
        ],
      }),
    );

    api.addRoutes({
      path: '/api/agent',
      methods: [apigwv2.HttpMethod.POST, apigwv2.HttpMethod.OPTIONS],
      integration: new integrations.HttpLambdaIntegration('AgentIntegration', agentFunction),
    });
  }
}
