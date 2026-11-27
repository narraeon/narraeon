export const chatGptPlanBaseUrl = "https://api.openai.com/v1";

export type ChatGptAuthErrorCode =
  | "local_only"
  | "busy"
  | "account_not_found"
  | "sign_in_required"
  | "plan_permission_required"
  | "authorization_failed"
  | "authorization_expired"
  | "service_unavailable"
  | "invalid_response"
  | "reauthorization_required"
  | "catalog_unavailable";

export interface ChatGptAccount {
  id: string;
  label: string;
  email?: string;
  status:
    | "signed_out"
    | "signed_in"
    | "plan_authorized"
    | "reauthorization_required";
}

export interface ChatGptModel {
  id: string;
  displayName: string;
}

export interface ChatGptSignInResult {
  status: "pending" | "completed" | "denied" | "failed" | "expired";
  account?: ChatGptAccount;
  error?: ChatGptAuthErrorCode;
}

export interface ChatGptDisconnectResult {
  account: ChatGptAccount;
  remoteRevocationConfirmed: boolean;
}
