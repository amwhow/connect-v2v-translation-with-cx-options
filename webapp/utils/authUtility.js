// Copyright 2025 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import { COGNITO_CONFIG, CONNECT_AUTH_CONFIG } from "../config";
import { LOGGER_PREFIX } from "../constants";

// In-memory token store — not accessible via window/document/localStorage,
// eliminating XSS risk for OAuth tokens. On page reload, tokens are lost and
// the user is seamlessly re-authenticated via the SAML IdP session.
const tokenStore = {
  accessToken: null,
  idToken: null,
  refreshToken: null,
};

export function setRedirectURI(redirectURI) {
  const currentUrl = redirectURI ?? window.location.href;
  const url = new URL(currentUrl);
  const redirectUri = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  //set redirect uri in sessionStorage (tab-scoped, cleared on tab close)
  sessionStorage.setItem("redirectUri", redirectUri);
}

function getRedirectURI() {
  return sessionStorage.getItem("redirectUri");
}

// Generate the Cognito OAuth authorize URL with SAML identity provider
// Uses /authorize (not /login) to skip the Cognito hosted UI and redirect
// directly to the configured SAML IdP (e.g., Azure AD / Entra ID)
export function getLoginUrl() {
  const params = new URLSearchParams({
    client_id: COGNITO_CONFIG.clientId,
    response_type: "code",
    scope: "email openid profile",
    redirect_uri: getRedirectURI(),
    identity_provider: COGNITO_CONFIG.samlProviderName,
  });

  return `${COGNITO_CONFIG.cognitoDomain}/authorize?${params.toString()}`;
}

// Handle the redirect from Cognito
export async function handleRedirect() {
  const urlParams = new URLSearchParams(window.location.search);
  const code = urlParams.get("code");

  if (code) {
    try {
      // Exchange the code for tokens
      const tokens = await getTokens(code);
      // Store tokens in memory
      setTokens(tokens);
      // Remove code from URL
      window.history.replaceState({}, document.title, window.location.pathname);
      return true;
    } catch (error) {
      console.error(`${LOGGER_PREFIX} - handleRedirect - Error exchanging code for tokens:`, error);
      return false;
    }
  }
  return false;
}

export async function getConnectAgentCredentials({ agentArn, agentUsername }) {
  if (!CONNECT_AUTH_CONFIG.connectAuthApiUrl) {
    throw new Error("Connect auth API URL is not configured.");
  }
  const response = await fetch(`${CONNECT_AUTH_CONFIG.connectAuthApiUrl}connect-agent-credentials`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ agentArn, agentUsername }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Connect agent auth failed: ${errorText}`);
  }

  const credentials = await response.json();
  setAwsCredentials(credentials);
  return credentials;
}

// Exchange authorization code for tokens
async function getTokens(code) {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: COGNITO_CONFIG.clientId,
    code: code,
    redirect_uri: getRedirectURI(),
  });

  const response = await fetch(`${COGNITO_CONFIG.cognitoDomain}/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  if (!response.ok) {
    throw new Error("Failed to exchange code for tokens");
  }
  const tokens = await response.json();
  const idTokenPayload = decodeToken(tokens.id_token);
  const idTokenExpires = new Date(idTokenPayload.exp * 1000);
  const accessTokenPayload = decodeToken(tokens.access_token);
  const accessTokenExpires = new Date(accessTokenPayload.exp * 1000);
  console.info(
    `${LOGGER_PREFIX} - getTokens - Tokens obtained, id_token expires at ${idTokenExpires.toISOString()}, access_token expires at ${accessTokenExpires.toISOString()}`
  );
  return tokens;
}

// Store tokens in the in-memory token store (not localStorage)
function setTokens(tokens) {
  tokenStore.accessToken = tokens.access_token;
  tokenStore.idToken = tokens.id_token;
  if (tokens.refresh_token) {
    tokenStore.refreshToken = tokens.refresh_token;
  }
}

// Store AWS credentials in sessionStorage (tab-scoped, cleared on tab close)
function setAwsCredentials(awsCredentials) {
  sessionStorage.setItem("awsCredentials", JSON.stringify(awsCredentials));
}

function getAwsCredentials() {
  const awsCredentials = sessionStorage.getItem("awsCredentials");
  return awsCredentials ? JSON.parse(awsCredentials) : null;
}

export function isTokenExpired(token) {
  if (token == null) return true;

  try {
    // Get payload from JWT token (second part between dots)
    const payload = JSON.parse(atob(token.split(".")[1]));

    // exp is in seconds, convert current time to seconds
    const currentTime = Math.floor(Date.now() / 1000);

    // Check if token has expired
    return payload.exp < currentTime;
  } catch (error) {
    console.error(`${LOGGER_PREFIX} - isTokenExpired - Error checking token expiration:`, error);
    return true;
  }
}

export async function refreshTokens() {
  const refreshToken = tokenStore.refreshToken;
  try {
    if (refreshToken == null) {
      throw new Error("No refresh token available");
    }

    const params = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: COGNITO_CONFIG.clientId,
      refresh_token: refreshToken,
    });

    const response = await fetch(`${COGNITO_CONFIG.cognitoDomain}/oauth2/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    if (!response.ok) {
      throw new Error("Failed to refresh tokens");
    }

    const tokens = await response.json();
    const idTokenPayload = decodeToken(tokens.id_token);
    const idTokenExpires = new Date(idTokenPayload.exp * 1000);
    const accessTokenPayload = decodeToken(tokens.access_token);
    const accessTokenExpires = new Date(accessTokenPayload.exp * 1000);
    setTokens(tokens);
    console.info(
      `${LOGGER_PREFIX} - refreshTokens - Tokens refreshed, id_token expire at ${idTokenExpires.toISOString()}, access_token expire at ${accessTokenExpires.toISOString()}`
    );
    return tokens;
  } catch (error) {
    console.error(`${LOGGER_PREFIX} - refreshTokens - Error refreshing tokens:`, error);
    // Clear stored tokens and redirect to login
    logout();
    throw error;
  }
}

// Update isAuthenticated to check in-memory tokens
export function isAuthenticated() {
  const idToken = tokenStore.idToken;
  const accessToken = tokenStore.accessToken;
  const refreshToken = tokenStore.refreshToken;
  if (idToken == null || accessToken == null || refreshToken == null) return false;
  if (isTokenExpired(idToken) || isTokenExpired(accessToken)) return false;
  return true;
}

// Get valid access token (refreshing if needed)
export async function getValidTokens() {
  const idToken = tokenStore.idToken;
  const accessToken = tokenStore.accessToken;
  const refreshToken = tokenStore.refreshToken;

  if (refreshToken == null) {
    console.error(`${LOGGER_PREFIX} - getValidTokens - No refresh token available`);
    // Clear stored tokens and redirect to login
    logout();
    return;
  }

  if (isTokenExpired(idToken) || isTokenExpired(accessToken)) {
    try {
      await refreshTokens();
    } catch (error) {
      console.error(`${LOGGER_PREFIX} - getValidTokens - Error refreshing tokens:`, error);
      // Clear stored tokens and redirect to login
      logout();
      return;
    }
  }
  return {
    accessToken: tokenStore.accessToken,
    idToken: tokenStore.idToken,
    refreshToken: tokenStore.refreshToken,
  };
}

// Helper to decode token payload
export function decodeToken(token) {
  try {
    return JSON.parse(atob(token.split(".")[1]));
  } catch (error) {
    console.error(`${LOGGER_PREFIX} - decodeToken - Error decoding token:`, error);
    return null;
  }
}

// Get user info from token
export function getUserInfo() {
  const token = tokenStore.idToken;
  if (!token) return null;

  const payload = decodeToken(token);
  return {
    email: payload.email,
    username: payload.preferred_username,
    sub: payload.sub,
  };
}

export function startTokenRefreshTimer() {
  const idToken = tokenStore.idToken;
  const accessToken = tokenStore.accessToken;

  if (idToken == null || accessToken == null) throw new Error("Unable to startTokenRefreshTimer - No tokens available");

  const idTokenPayload = decodeToken(idToken);
  const accessTokenPayload = decodeToken(accessToken);
  if (idTokenPayload == null || accessTokenPayload == null) throw new Error("Unable to startTokenRefreshTimer - Error decoding tokens");

  // Calculate time until token expires
  const idTokenExpiresIn = idTokenPayload.exp * 1000 - Date.now();
  const accessTokenExpiresIn = accessTokenPayload.exp * 1000 - Date.now();
  const firstTokenExpiresIn = Math.min(idTokenExpiresIn, accessTokenExpiresIn);

  // Refresh 4 minutes before expiration
  let refreshTime = firstTokenExpiresIn - 4 * 60 * 1000;
  if (refreshTime < 0) refreshTime = 0;

  console.info(`${LOGGER_PREFIX} - startTokenRefreshTimer - Token refresh timer set for ${Math.floor(refreshTime / 1000)}s`);
  setTimeout(async () => {
    try {
      await refreshTokens();
      await getValidAwsCredentials();
      // Start new timer after refresh
      startTokenRefreshTimer();
    } catch (error) {
      console.error(`${LOGGER_PREFIX} - startTokenRefreshTimer - Error in refresh timer:`, error);
    }
  }, refreshTime);
}

export function logout() {
  const params = new URLSearchParams({
    client_id: COGNITO_CONFIG.clientId,
    logout_uri: getRedirectURI(),
  });

  // Clear in-memory tokens
  tokenStore.accessToken = null;
  tokenStore.idToken = null;
  tokenStore.refreshToken = null;

  // Clear sessionStorage
  sessionStorage.removeItem("awsCredentials");
  sessionStorage.removeItem("redirectUri");

  // Redirect to Cognito logout (which triggers SAML IdP single logout if configured)
  window.location.href = `${COGNITO_CONFIG.cognitoDomain}/logout?${params.toString()}`;
}

async function getCognitoIdentityCredentials(idToken) {
  // First, get the Cognito Identity ID
  const identityParams = {
    IdentityPoolId: COGNITO_CONFIG.identityPoolId,
    Logins: {
      [`cognito-idp.${COGNITO_CONFIG.region}.amazonaws.com/${COGNITO_CONFIG.userPoolId}`]: idToken,
    },
  };

  try {
    // Get Identity ID
    const cognitoIdentity = new AWS.CognitoIdentity({
      region: COGNITO_CONFIG.region,
    });
    const { IdentityId } = await cognitoIdentity.getId(identityParams).promise();

    // Get credentials
    const cognitoCredentialsForIdentity = await cognitoIdentity
      .getCredentialsForIdentity({
        IdentityId,
        Logins: {
          [`cognito-idp.${COGNITO_CONFIG.region}.amazonaws.com/${COGNITO_CONFIG.userPoolId}`]: idToken,
        },
      })
      .promise();

    const credentials = {
      accessKeyId: cognitoCredentialsForIdentity.Credentials.AccessKeyId,
      secretAccessKey: cognitoCredentialsForIdentity.Credentials.SecretKey,
      sessionToken: cognitoCredentialsForIdentity.Credentials.SessionToken,
      expiration: cognitoCredentialsForIdentity.Credentials.Expiration,
    };

    console.info(`${LOGGER_PREFIX} - getCognitoIdentityCredentials - Cognito Identity credentials obtained, expire at ${credentials.expiration.toISOString()}`);
    setAwsCredentials(credentials);
    return credentials;
  } catch (error) {
    console.error(`${LOGGER_PREFIX} - getCognitoIdentityCredentials - Error getting Cognito Identity credentials:`, error);
    throw error;
  }
}

async function getUnauthenticatedCredentials() {
  const identityParams = {
    IdentityPoolId: COGNITO_CONFIG.identityPoolId,
  };

  try {
    const cognitoIdentity = new AWS.CognitoIdentity({
      region: COGNITO_CONFIG.region,
    });
    const { IdentityId } = await cognitoIdentity.getId(identityParams).promise();

    const cognitoCredentialsForIdentity = await cognitoIdentity
      .getCredentialsForIdentity({
        IdentityId,
      })
      .promise();

    const credentials = {
      accessKeyId: cognitoCredentialsForIdentity.Credentials.AccessKeyId,
      secretAccessKey: cognitoCredentialsForIdentity.Credentials.SecretKey,
      sessionToken: cognitoCredentialsForIdentity.Credentials.SessionToken,
      expiration: cognitoCredentialsForIdentity.Credentials.Expiration,
    };

    console.info(`${LOGGER_PREFIX} - getUnauthenticatedCredentials - Cognito guest credentials obtained, expire at ${credentials.expiration.toISOString()}`);
    setAwsCredentials(credentials);
    return credentials;
  } catch (error) {
    console.error(`${LOGGER_PREFIX} - getUnauthenticatedCredentials - Error getting guest credentials:`, error);
    throw error;
  }
}

// Get AWS credentials using Cognito Identity Pool
export async function getValidAwsCredentials() {
  try {
    if (hasValidAwsCredentials()) {
      return getAwsCredentials();
    }

    const refreshToken = tokenStore.refreshToken;
    if (refreshToken == null) {
      return await getUnauthenticatedCredentials();
    }

    const tokens = await getValidTokens();

    if (tokens?.accessToken == null || tokens?.idToken == null || tokens?.refreshToken == null) {
      return await getUnauthenticatedCredentials();
    }

    // Configure the credentials provider
    const credentials = await getCognitoIdentityCredentials(tokens.idToken);
    return credentials;
  } catch (error) {
    console.error(`${LOGGER_PREFIX} - getValidAwsCredentials - Error getting AWS credentials:`, error);
    throw error;
  }
}

export function hasValidAwsCredentials() {
  const awsCredentials = getAwsCredentials();
  if (
    awsCredentials?.accessKeyId == null ||
    awsCredentials?.secretAccessKey == null ||
    awsCredentials?.sessionToken == null ||
    awsCredentials?.expiration == null
  ) {
    return false;
  }

  // Add a 15-minute buffer before expiration
  const bufferTime = 15 * 60 * 1000; // 15 minutes in milliseconds
  const currentTime = new Date();
  const expirationTime = new Date(awsCredentials.expiration);

  return currentTime.getTime() + bufferTime < expirationTime.getTime();
}
