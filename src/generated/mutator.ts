import axios, { AxiosRequestConfig, AxiosInstance, AxiosResponse } from "axios";

let currentBaseUrl = "";
let currentApiToken = "";
let currentTenantId = "";

const createAxiosInstance = (): AxiosInstance => {
  const headers: Record<string, string> = {};
  if (currentApiToken) {
    headers["Authorization"] = `Bearer ${currentApiToken}`;
  }
  if (currentTenantId) {
    headers["X-Tenant-ID"] = currentTenantId;
  }
  return axios.create({ baseURL: currentBaseUrl, headers });
};

let AXIOS_INSTANCE = createAxiosInstance();

export const setApiConfig = (config: {
  baseUrl: string;
  apiToken?: string;
  tenantId?: string;
}) => {
  currentBaseUrl = config.baseUrl;
  currentApiToken = config.apiToken || "";
  currentTenantId = config.tenantId || "";
  AXIOS_INSTANCE = createAxiosInstance();
};

export const customInstance = <T>(
  config: AxiosRequestConfig,
  options?: AxiosRequestConfig,
): Promise<T> => {
  const controller = new AbortController();
  const promise = AXIOS_INSTANCE({
    ...config,
    ...options,
    signal: controller.signal,
  }).then((response: AxiosResponse<T>) => response.data) as Promise<T> & {
    cancel: () => void;
  };
  promise.cancel = () => controller.abort();
  return promise;
};

export type ErrorType<Error> = Error;
