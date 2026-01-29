// Copyright 2025 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
const { S3 } = require("aws-sdk");

const s3 = new S3();

const buildObjectKey = (contactId) => {
  const safeContactId = String(contactId || "unknown").replace(/[^a-zA-Z0-9-_.]/g, "_");
  const timestamp = new Date().toISOString();
  return `${safeContactId}/${timestamp}.json`;
};

const parseBody = (event) => {
  if (!event.body) {
    return null;
  }
  const body = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
  return JSON.parse(body);
};

exports.handler = async (event) => {
  const transcriptBucket = process.env.TRANSCRIPT_BUCKET;
  if (!transcriptBucket) {
    throw new Error("TRANSCRIPT_BUCKET environment variable is not set.");
  }

  const payload = parseBody(event);
  if (!payload) {
    return {
      statusCode: 400,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "content-type",
        "access-control-allow-methods": "POST,OPTIONS",
      },
      body: JSON.stringify({ message: "Missing request body." }),
    };
  }

  const objectKey = buildObjectKey(payload.contactId);
  await s3
    .putObject({
      Bucket: transcriptBucket,
      Key: objectKey,
      Body: JSON.stringify(payload, null, 2),
      ContentType: "application/json",
    })
    .promise();

  return {
    statusCode: 200,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "POST,OPTIONS",
    },
    body: JSON.stringify({ message: "Stored transcript.", key: objectKey }),
  };
};
