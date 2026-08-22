#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';

import { PROJECT_NAME, STACK_NAME, TARGET_REGION } from '../lib/constants';
import { RoofingCrmStack } from '../lib/roofing-crm-stack';

const app = new cdk.App();

new RoofingCrmStack(app, STACK_NAME, {
  description:
    'Roofing CRM and lead identification UI for Chester County, PA - static site, lead store and agent API',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    // Region is fixed by the engineering guidelines, not inherited from the caller's profile.
    region: TARGET_REGION,
  },
  tags: {
    project_name: PROJECT_NAME,
  },
});
