export interface RestApiBearerAuthConfig {
  type: "Bearer";
  token: string;
}

export type RestApiAuthConfig = RestApiBearerAuthConfig;

export function buildRestApiAuthHeaders(auth: RestApiAuthConfig): HeadersInit {
  return {
    Authorization: `Bearer ${auth.token}`,
  };
}
