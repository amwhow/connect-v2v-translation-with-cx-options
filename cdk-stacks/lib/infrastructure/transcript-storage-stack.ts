// Copyright 2025 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as apigatewayv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as apigatewayv2Integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";

export interface TranscriptStorageStackProps extends cdk.NestedStackProps {
  readonly cdkAppName: string;
}

export class TranscriptStorageStack extends cdk.NestedStack {
  public readonly transcriptApiUrl: string;

  constructor(scope: Construct, id: string, props: TranscriptStorageStackProps) {
    super(scope, id, props);

    const transcriptBucket = new s3.Bucket(this, "TranscriptBucket", {
      bucketName: `${props.cdkAppName}-TranscriptBucket-${this.account}-${this.region}`.toLowerCase(),
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const transcriptWriter = new lambda.Function(this, "TranscriptWriter", {
      functionName: `${props.cdkAppName}-TranscriptWriter`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "index.handler",
      code: lambda.Code.fromAsset("lambdas/transcript-storage"),
      timeout: cdk.Duration.seconds(10),
      environment: {
        TRANSCRIPT_BUCKET: transcriptBucket.bucketName,
      },
    });

    transcriptBucket.grantWrite(transcriptWriter);

    const httpApi = new apigatewayv2.HttpApi(this, "TranscriptApi", {
      apiName: `${props.cdkAppName}-TranscriptApi`,
      corsPreflight: {
        allowHeaders: ["content-type"],
        allowMethods: [apigatewayv2.CorsHttpMethod.POST, apigatewayv2.CorsHttpMethod.OPTIONS],
        allowOrigins: ["*"],
        maxAge: cdk.Duration.days(10),
      },
    });

    httpApi.addRoutes({
      path: "/transcripts",
      methods: [apigatewayv2.HttpMethod.POST],
      integration: new apigatewayv2Integrations.HttpLambdaIntegration("TranscriptWriterIntegration", transcriptWriter),
    });

    this.transcriptApiUrl = `${httpApi.url}transcripts`;
  }
}
