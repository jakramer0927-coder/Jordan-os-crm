import { google } from "googleapis";

export function getGoogleOAuthClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID!;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET!;
  const redirectUri = `${process.env.APP_BASE_URL}/api/google/oauth/callback`;

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/spreadsheets.readonly",
];