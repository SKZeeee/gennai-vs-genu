import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export class CustomAwsSpecialistStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const imageRepositoryName = this.node.tryGetContext('imageRepositoryName') ?? 'aws-specialist-agent';
    const imageTag = this.node.tryGetContext('imageTag') ?? 'latest';
    const departmentConsultEmail = this.node.tryGetContext('departmentConsultEmail') ?? 'aws-consult@example.com';
    const invokeTimeoutSeconds = Number(this.node.tryGetContext('invokeTimeoutSeconds') ?? 300);
    const apiRateLimit = Number(this.node.tryGetContext('apiRateLimit') ?? 10);
    const apiBurstLimit = Number(this.node.tryGetContext('apiBurstLimit') ?? 20);
    const apiMonthlyQuota = Number(this.node.tryGetContext('apiMonthlyQuota') ?? 100000);
    const currentDir = path.dirname(fileURLToPath(import.meta.url));

    if (!Number.isInteger(invokeTimeoutSeconds) || invokeTimeoutSeconds < 3 || invokeTimeoutSeconds > 300) {
      throw new Error('invokeTimeoutSeconds must be an integer between 3 and 300');
    }

    const attachmentBucket = new s3.Bucket(this, 'AttachmentBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      lifecycleRules: [
        { expiration: cdk.Duration.days(1), prefix: 'attachments/exapp/' },
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const repository = ecr.Repository.fromRepositoryName(
      this,
      'AgentImageRepository',
      imageRepositoryName,
    );

    const runtime = new agentcore.Runtime(this, 'AwsSpecialistRuntime', {
      runtimeName: 'gennai_aws_specialist',
      agentRuntimeArtifact: agentcore.AgentRuntimeArtifact.fromEcrRepository(repository, imageTag),
      networkConfiguration: agentcore.RuntimeNetworkConfiguration.usingPublicNetwork(),
      environmentVariables: {
        AWS_MCP_ENDPOINT: 'https://aws-mcp.us-east-1.api.aws/mcp',
        AWS_MCP_REGION: 'us-east-1',
        AWS_MCP_SERVICE: 'aws-mcp',
        ENABLE_AWS_PRICING_MCP: 'true',
        AWS_PRICING_MCP_COMMAND: 'uvx',
        AWS_PRICING_MCP_ARGS: 'awslabs.aws-pricing-mcp-server@latest',
        DEPARTMENT_CONSULT_EMAIL: departmentConsultEmail,
        ATTACHMENT_BUCKET_NAME: attachmentBucket.bucketName,
        ATTACHMENT_KEY_PREFIX: 'attachments/',
      },
    });

    runtime.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: ['arn:aws:bedrock:*::foundation-model/*', 'arn:aws:bedrock:*:*:inference-profile/*'],
    }));
    runtime.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'pricing:DescribeServices', 'pricing:GetAttributeValues', 'pricing:GetPriceListFileUrl',
        'pricing:GetProducts', 'pricing:ListPriceLists',
      ],
      resources: ['*'],
    }));
    attachmentBucket.grantRead(runtime.role, 'attachments/*');

    const invokeFunction = new nodejs.NodejsFunction(this, 'ExAppInvokeFunction', {
      entry: path.join(currentDir, '../lambda/handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(invokeTimeoutSeconds),
      memorySize: 512,
      environment: {
        AGENT_RUNTIME_ARN: runtime.agentRuntimeArn,
        AGENT_RUNTIME_QUALIFIER: 'DEFAULT',
        ATTACHMENT_BUCKET_NAME: attachmentBucket.bucketName,
      },
      bundling: { minify: true, sourceMap: true },
    });
    attachmentBucket.grantReadWrite(invokeFunction, 'attachments/*');
    invokeFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock-agentcore:InvokeAgentRuntime', 'bedrock-agentcore:InvokeAgentRuntimeForUser'],
      resources: [runtime.agentRuntimeArn, `${runtime.agentRuntimeArn}/runtime-endpoint/*`],
    }));

    const api = new apigateway.RestApi(this, 'ExAppApi', {
      restApiName: 'gennai-custom-aws-specialist',
      endpointConfiguration: { types: [apigateway.EndpointType.REGIONAL] },
      deployOptions: { stageName: 'api', tracingEnabled: true, metricsEnabled: true },
    });
    const apiKey = api.addApiKey('ExAppApiKey');
    const plan = api.addUsagePlan('ExAppUsagePlan', {
      throttle: { rateLimit: apiRateLimit, burstLimit: apiBurstLimit },
      quota: { limit: apiMonthlyQuota, period: apigateway.Period.MONTH },
    });
    plan.addApiKey(apiKey);
    plan.addApiStage({ stage: api.deploymentStage });

    const requests = api.root.addResource('requests');
    requests.addMethod('POST', new apigateway.LambdaIntegration(invokeFunction, {
      proxy: true,
      timeout: cdk.Duration.seconds(invokeTimeoutSeconds),
    }), { apiKeyRequired: true });

    new cdk.CfnOutput(this, 'ExAppEndpoint', { value: api.urlForPath('/requests') });
    new cdk.CfnOutput(this, 'ExAppApiKeyId', { value: apiKey.keyId });
    new cdk.CfnOutput(this, 'AgentRuntimeArn', { value: runtime.agentRuntimeArn });
    new cdk.CfnOutput(this, 'AttachmentBucketName', { value: attachmentBucket.bucketName });
  }
}
