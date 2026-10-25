export const googleErrors = {
  unavailable:
    "Google sign-in is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and a valid APP_URL on the server. Email/password sign-in remains available.",
  expired:
    "This Google sign-in request expired or could not be verified. Please start again in the same browser.",
  denied:
    "Google sign-in was cancelled or permission was not granted. You can try again or use email and password.",
  identity:
    "Google could not verify this account. A valid, verified email address is required. Please try again.",
  existing:
    "An account already uses this email. Sign in with your existing method, then connect Google from My trips using your current password. Accounts are never linked automatically.",
  link: "Google could not be connected. Use the Google account with the same verified email as your signed-in account; a Google account cannot belong to two customer accounts.",
  session:
    "Your sign-in session changed during Google authentication. Please start again.",
  failed:
    "Google sign-in could not be completed. Please retry or use email and password.",
} as const;
