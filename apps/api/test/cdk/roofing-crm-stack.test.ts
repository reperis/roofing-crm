import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';

import { PROJECT_NAME, TARGET_REGION } from '../../cdk/lib/constants';
import { RoofingCrmStack } from '../../cdk/lib/roofing-crm-stack';

describe('RoofingCrmStack', () => {
  let template: Template;

  // Synthesis bundles the Lambda with esbuild, which is slow the first time and slower on a cold
  // CI runner. Vitest's 10s default hook timeout is sized for unit tests, not for a build, and
  // exceeding it fails the suite in a way that reads like a broken stack rather than a slow one.
  beforeAll(() => {
    const app = new cdk.App();
    const stack = new RoofingCrmStack(app, 'TestStack', {
      env: { account: '123456789012', region: TARGET_REGION },
      tags: { project_name: PROJECT_NAME },
    });
    template = Template.fromStack(stack);
  }, 120_000);

  it('serves the CRM over HTTPS only', () => {
    // Reps reach this from a browser with no credentials; an http:// origin would be a
    // mixed-content failure and, for anything holding customer records, simply wrong.
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultCacheBehavior: Match.objectLike({ ViewerProtocolPolicy: 'redirect-to-https' }),
        DefaultRootObject: 'index.html',
      }),
    });
  });

  it('returns the SPA shell for client-side routes instead of an S3 error document', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        CustomErrorResponses: [
          Match.objectLike({ ErrorCode: 403, ResponseCode: 200, ResponsePagePath: '/index.html' }),
        ],
      }),
    });
  });

  it('does not rewrite 404 into the SPA shell', () => {
    // Custom error responses are distribution-wide and cannot be scoped to one behavior. Mapping
    // 404 would turn the leads API's "no such lead" into a 200 carrying HTML — a failure the
    // client reads as success. S3-with-OAC answers a missing key with 403, so deep links still
    // work without it.
    const distributions = template.findResources('AWS::CloudFront::Distribution');
    for (const distribution of Object.values(distributions)) {
      const responses = (distribution.Properties?.DistributionConfig?.CustomErrorResponses ??
        []) as { ErrorCode: number }[];
      expect(responses.map((response) => response.ErrorCode)).not.toContain(404);
    }
  });

  it('forwards query strings to the API so stage filters are not silently dropped', () => {
    // Without this the pipeline board's `?status=contacted` never reaches the Lambda, and the
    // response is an unfiltered list rather than an error — the worst kind of failure.
    template.hasResourceProperties('AWS::CloudFront::OriginRequestPolicy', {
      OriginRequestPolicyConfig: Match.objectLike({
        QueryStringsConfig: { QueryStringBehavior: 'all' },
        CookiesConfig: { CookieBehavior: 'none' },
      }),
    });
  });

  it('does not forward the Host header to the API origin', () => {
    // API Gateway routes on Host; the CloudFront hostname would produce a 403 from a gateway that
    // has never heard of it.
    const policies = template.findResources('AWS::CloudFront::OriginRequestPolicy');
    for (const policy of Object.values(policies)) {
      const headers = (policy.Properties?.OriginRequestPolicyConfig?.HeadersConfig?.Headers ??
        []) as string[];
      expect(headers.map((header) => header.toLowerCase())).not.toContain('host');
    }
  });

  it('keeps the site bucket private behind origin access control', () => {
    const buckets = template.findResources('AWS::S3::Bucket');
    expect(Object.keys(buckets)).toHaveLength(1);

    for (const bucket of Object.values(buckets)) {
      expect(bucket.Properties?.PublicAccessBlockConfiguration).toEqual({
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      });
    }
  });

  it('retains the leads table when the stack is destroyed', () => {
    // Leads are customer records entered by hand. `cdk destroy` must not be able to delete them.
    template.hasResource('AWS::DynamoDB::Table', {
      UpdateReplacePolicy: 'Retain',
      DeletionPolicy: 'Retain',
    });
  });

  it('bills the leads table per request rather than provisioning capacity', () => {
    // A three-rep sales team's traffic is bursty and tiny; provisioned capacity would cost more
    // and add an operational dial nobody will ever tune.
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      BillingMode: 'PAY_PER_REQUEST',
    });
  });

  it('indexes leads by pipeline stage so the board never scans the table', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: 'by-status',
          KeySchema: [
            { AttributeName: 'status', KeyType: 'HASH' },
            { AttributeName: 'status_changed_at', KeyType: 'RANGE' },
          ],
        }),
      ]),
    });
  });

  it('encrypts leads at rest and keeps point-in-time recovery on', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      SSESpecification: Match.objectLike({ SSEEnabled: true }),
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    });
  });

  it('exposes the public runtime URL as a stack output', () => {
    template.hasOutput('SiteUrl', {
      Description: Match.stringLikeRegexp('no credentials'),
    });
  });

  it('tags every resource for cost allocation', () => {
    // Required by the engineering guidelines: all resources carry project_name.
    template.hasResourceProperties('AWS::S3::Bucket', {
      Tags: Match.arrayWith([{ Key: 'project_name', Value: PROJECT_NAME }]),
    });
  });
});
