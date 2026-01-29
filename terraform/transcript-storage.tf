terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

variable "aws_region" {
  description = "AWS region to deploy transcript storage resources."
  type        = string
  default     = "us-east-1"
}

variable "app_name" {
  description = "Prefix used for transcript storage resources."
  type        = string
  default     = "AmazonConnectV2V"
}

data "aws_caller_identity" "current" {}

locals {
  bucket_name   = lower("${var.app_name}-transcripts-${data.aws_caller_identity.current.account_id}-${var.aws_region}")
  lambda_name   = "${var.app_name}-TranscriptWriter"
  api_name      = "${var.app_name}-TranscriptApi"
  lambda_source = "${path.module}/../cdk-stacks/lambdas/transcript-storage/index.js"
}

data "archive_file" "lambda_zip" {
  type        = "zip"
  source_file = local.lambda_source
  output_path = "${path.module}/.build/transcript-writer.zip"
}

resource "aws_s3_bucket" "transcripts" {
  bucket        = local.bucket_name
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "transcripts" {
  bucket                  = aws_s3_bucket.transcripts.id
  block_public_acls       = true
  ignore_public_acls      = true
  block_public_policy     = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "transcripts" {
  bucket = aws_s3_bucket.transcripts.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_iam_role" "lambda_role" {
  name = "${local.lambda_name}-Role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
        Action = "sts:AssumeRole"
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "lambda_basic" {
  role       = aws_iam_role.lambda_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "lambda_s3_write" {
  name = "${local.lambda_name}-S3Write"
  role = aws_iam_role.lambda_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:PutObject"]
        Resource = "${aws_s3_bucket.transcripts.arn}/*"
      }
    ]
  })
}

resource "aws_lambda_function" "transcript_writer" {
  function_name = local.lambda_name
  role          = aws_iam_role.lambda_role.arn
  handler       = "index.handler"
  runtime       = "nodejs20.x"
  timeout       = 10

  filename         = data.archive_file.lambda_zip.output_path
  source_code_hash = data.archive_file.lambda_zip.output_base64sha256

  environment {
    variables = {
      TRANSCRIPT_BUCKET = aws_s3_bucket.transcripts.bucket
    }
  }
}

resource "aws_apigatewayv2_api" "transcript_api" {
  name          = local.api_name
  protocol_type = "HTTP"

  cors_configuration {
    allow_headers = ["Content-Type"]
    allow_methods = ["POST", "OPTIONS"]
    allow_origins = ["*"]
    max_age       = 864000
  }
}

resource "aws_apigatewayv2_integration" "transcript_writer" {
  api_id                 = aws_apigatewayv2_api.transcript_api.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.transcript_writer.arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "transcripts" {
  api_id    = aws_apigatewayv2_api.transcript_api.id
  route_key = "POST /transcripts"
  target    = "integrations/${aws_apigatewayv2_integration.transcript_writer.id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.transcript_api.id
  name        = "$default"
  auto_deploy = true
}

resource "aws_lambda_permission" "api_invoke" {
  statement_id  = "AllowApiGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.transcript_writer.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.transcript_api.execution_arn}/*/*/transcripts"
}

output "transcript_api_url" {
  value = "${aws_apigatewayv2_api.transcript_api.api_endpoint}/transcripts"
}
