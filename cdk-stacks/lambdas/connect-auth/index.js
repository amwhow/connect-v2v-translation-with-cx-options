// Copyright 2025 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
const AWS = require("aws-sdk");

const connect = new AWS.Connect({ region: process.env.CONNECT_INSTANCE_REGION });
const sts = new AWS.STS();

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

function response(statusCode, body) {
  return {
    statusCode,
    headers: corsHeaders,
    body: JSON.stringify(body),
  };
}

function parseAgentArn(agentArn) {
  if (!agentArn) return null;
  const match = agentArn.match(/instance\/([^/]+)\/agent\/([^/]+)$/);
  if (!match) return null;
  return { instanceId: match[1], userId: match[2] };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return response(200, {});
  }

  let payload = {};
  try {
    payload = event.body ? JSON.parse(event.body) : {};
  } catch (error) {
    console.warn("Invalid JSON body.", error);
    return response(400, { message: "Invalid request body." });
  }

  const { agentArn, agentUsername } = payload;
  if (!agentArn || !agentUsername) {
    return response(400, { message: "agentArn and agentUsername are required." });
  }

  const arnParts = parseAgentArn(agentArn);
  if (!arnParts) {
    return response(400, { message: "Invalid agentArn format." });
  }

  try {
    const userResponse = await connect
      .describeUser({
        InstanceId: arnParts.instanceId,
        UserId: arnParts.userId,
      })
      .promise();

    if (userResponse?.User?.Username !== agentUsername) {
      return response(403, { message: "Agent identity verification failed." });
    }

    const assumeRoleResponse = await sts
      .assumeRole({
        RoleArn: process.env.CONNECT_AGENT_ROLE_ARN,
        RoleSessionName: `connect-agent-${arnParts.userId}`,
        DurationSeconds: 3600,
      })
      .promise();

    const credentials = assumeRoleResponse.Credentials;
    if (!credentials) {
      return response(500, { message: "Unable to issue credentials." });
    }

    return response(200, {
      accessKeyId: credentials.AccessKeyId,
      secretAccessKey: credentials.SecretAccessKey,
      sessionToken: credentials.SessionToken,
      expiration: credentials.Expiration?.toISOString?.() ?? credentials.Expiration,
    });
  } catch (error) {
    console.error("Connect agent auth failed.", error);
    return response(500, { message: "Connect agent authentication failed." });
  }
};
