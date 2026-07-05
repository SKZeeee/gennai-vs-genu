#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CustomAwsSpecialistStack } from '../lib/custom-aws-specialist-stack.js';

const app = new cdk.App();

new CustomAwsSpecialistStack(app, 'GennaiCustomAwsSpecialistStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'ap-northeast-1',
  },
});
