import * as path from 'node:path';

import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import type { Construct } from 'constructs';

import { PROJECT_NAME } from './constants';

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
      // Client-side routing: unknown paths must return the SPA shell, not an S3 error document.
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        },
        {
          httpStatus: 404,
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
  }
}
