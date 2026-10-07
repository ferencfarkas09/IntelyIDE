// Backend of the contract module. In the Tauri app every call goes to the `contract_*` commands; in a plain browser
// (mock UI, Playwright, vitest) a deterministic in-memory fixture with the same shapes stands in. Read-only: no call
// here sends an API request, writes a file or changes a repository.
import { call } from "../../ipc/rpc";
import { isShowcase } from "../../ipc/mock/showcase";
import type { ClientReport, Detail, Endpoint, Finding, Report, SchemaNode } from "./types";

/** The `showcase` scenario (website screenshots) shows an online-shop API instead of the banking fixture: same shapes, other words. */
const SWAPS: [RegExp, string][] = [
  [/Happy API/g, "Acme Shop API"], [/Fixture description for the explorer\./g, "Returns the record with the given identifier."], [/Example Bank/g, "Jane Doe"], [/Account number/g, "E-mail address"], [/Restaurants of the user/g, "Loyalty tiers of the shop"],
  [/List banks for one store/g, "List customers of one shop"], [/Create a bank/g, "Create a customer"], [/Remove a bank/g, "Remove a customer"], [/One bank/g, "One customer"],
  [/\/api\/restaurants\/list/g, "/api/loyalty/tiers"], [/\/restaurant\/list/g, "/loyalty/tiers"], [/getRestaurants/g, "getTiers"], [/restaurant\.swagger/g, "loyalty.swagger"],
  [/"Restaurant"/g, '"Loyalty"'], [/restaurantId/g, "shopId"], [/iban/g, "email"], [/"mobile"/g, '"services"'],
  [/bankNetworking/g, "customerNetworking"], [/bank\.swagger/g, "customer.swagger"], [/Banks/g, "Customers"], [/getBankz/g, "getCustomerz"], [/Bank/g, "Customer"], [/banks/g, "customers"], [/bankId/g, "customerId"], [/bank/g, "customer"],
];
const themed = <T,>(value: T): T => (isShowcase() ? (JSON.parse(SWAPS.reduce((json, [from, to]) => json.replace(from, to), JSON.stringify(value))) as T) : value);

export interface ContractApi {
  analyze(specRepoId?: string): Promise<Report>;
  detail(endpointId: string): Promise<Detail>;
  definition(name: string): Promise<SchemaNode>;
}

export const inTauri = (): boolean => typeof window !== "undefined" && !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;

const tauriApi: ContractApi = {
  analyze: (specRepoId) => call("contract_analyze", { specRepoId: specRepoId ?? null }),
  detail: (endpointId) => call("contract_detail", { endpointId }),
  definition: (name) => call("contract_definition", { name }),
};

let override: ContractApi | undefined;
/** Tests inject their own backend. */
export const setContractApi = (api: ContractApi | undefined): void => void (override = api);

let mock: ContractApi | undefined;
export function contractApi(): ContractApi {
  if (override) return override;
  if (inTauri()) return tauriApi;
  return (mock ??= createMockContract());
}

const node = (type: string, extra: Partial<SchemaNode> = {}): SchemaNode => ({ type, format: null, description: null, required: false, enum: [], example: null, default: null, refName: null, props: [], items: null, additional: null, circular: false, truncated: false, ...extra });
const prop = (name: string, n: SchemaNode, required = false) => ({ name, node: { ...n, required } });

const BANK: SchemaNode = themed(node("object", {
  refName: "Bank",
  props: [
    prop("_id", node("string", { description: "Identifier" })),
    prop("name", node("string", { example: "Example Bank" }), true),
    prop("iban", node("string", { description: "Account number" })),
    prop("status", node("string", { enum: ["active", "closed"] })),
    prop("owner", node("object", { refName: "Person", props: [prop("name", node("string")), prop("bank", node("object", { refName: "Bank", circular: true }))] })),
  ],
}));
const ORDER: SchemaNode = node("object", { refName: "Order", props: [prop("id", node("string")), prop("total", node("number")), prop("state", node("string", { enum: ["open", "paid"] })), prop("createdAt", node("string", { format: "date-time" }))] });

const ep = (method: string, path: string, line: number, extra: Partial<Endpoint> = {}): Endpoint => ({
  id: `${method} ${path}`,
  method,
  path,
  operationId: null,
  tags: [],
  summary: "",
  deprecated: false,
  params: [],
  bodyRequired: false,
  hasBody: false,
  request: null,
  response: null,
  source: { file: "src/api/swagger/bank.swagger.yaml", line },
  ...extra,
});

const ENDPOINTS: Endpoint[] = themed([
  ep("GET", "/api/banks", 2, { operationId: "getBanks", tags: ["Banks"], summary: "List banks for one store", params: [{ name: "restaurantId", in: "query", required: true, type: "string" }], response: { array: true, props: ["_id", "name", "iban", "status", "owner"], required: ["name"], open: false } }),
  ep("POST", "/api/banks", 2, { operationId: "createBank", tags: ["Banks"], summary: "Create a bank", hasBody: true, bodyRequired: true }),
  ep("GET", "/api/banks/{bankId}", 40, { operationId: "getBank", tags: ["Banks"], summary: "One bank", params: [{ name: "bankId", in: "path", required: true, type: "string" }], response: { array: false, props: ["_id", "name", "iban", "status", "owner"], required: ["name"], open: false } }),
  ep("DELETE", "/api/banks/{bankId}", 40, { operationId: "deleteBank", tags: ["Banks"], summary: "Remove a bank", deprecated: true, params: [{ name: "bankId", in: "path", required: true, type: "string" }] }),
  ep("GET", "/api/order/{orderId}", 12, { operationId: "getOrder", tags: ["Order"], summary: "One order", params: [{ name: "orderId", in: "path", required: true, type: "string" }], response: { array: false, props: ["id", "total", "state", "createdAt"], required: [], open: false }, source: { file: "src/api/swagger/order.swagger.yaml", line: 12 } }),
  ep("POST", "/api/order/courier/labels", 88, { operationId: "courierLabels", tags: ["Order"], summary: "Create courier labels", source: { file: "src/api/swagger/order.swagger.yaml", line: 88 } }),
  ep("GET", "/api/restaurants/list", 5, { operationId: "getRestaurants", tags: ["Restaurant"], summary: "Restaurants of the user", source: { file: "src/api/swagger/restaurant.swagger.yaml", line: 5 } }),
  ep("GET", "/api/unused/thing", 3, { operationId: "unusedThing", tags: ["Misc"], summary: "Nobody calls this", source: { file: "src/api/swagger/misc.swagger.yaml", line: 3 } }),
]);

const site = (repoId: string, file: string, line: number, snippet: string) => ({ repoId, file, line, col: 5, snippet });
const finding = (n: number, f: Omit<Finding, "id" | "heuristic" | "suggestion" | "names" | "allowed" | "swagger"> & Partial<Finding>): Finding => ({ id: `f${n}`, heuristic: false, suggestion: null, names: [], allowed: [], swagger: null, ...f });
const sug = (e: Endpoint, similarity: number) => ({ id: e.id, method: e.method, path: e.path, operationId: e.operationId, similarity, source: e.source });

function report(): Report {
  const adminFile = "src/networking/bankNetworking.js";
  const mobileFile = "app/helpers/orderApi.js";
  const admin: ClientReport = {
    repoId: "admin",
    fingerprint: "a1b2c3d4e5f6-9f8e7d",
    cached: false,
    counts: { files: 2520, calls: 6, matched: 4, errors: 2, warnings: 3, infos: 0 },
    findings: [
      finding(1, { kind: "renamed", severity: "error", confidence: "high", repoId: "admin", site: site("admin", adminFile, 42, "window.swaggerClient.apis.Banks.getBankz({})"), target: "Banks.getBankz", suggestion: sug(ENDPOINTS[2], 0.86) }),
      finding(2, { kind: "missing", severity: "error", confidence: "high", repoId: "admin", site: site("admin", adminFile, 77, "window.swaggerClient.apis.Nope.completelyDifferentThing({})"), target: "Nope.completelyDifferentThing" }),
      finding(3, { kind: "requiredParam", severity: "warn", confidence: "medium", repoId: "admin", site: site("admin", adminFile, 12, "window.swaggerClient.apis.Banks.getBanks({})"), target: "Banks.getBanks", names: ["restaurantId"], swagger: ENDPOINTS[0].source }),
      finding(4, { kind: "tagMismatch", severity: "warn", confidence: "medium", repoId: "admin", site: site("admin", adminFile, 58, "window.swaggerClient.apis.Order.getBank({ bankId })"), target: "Order.getBank", names: ["Banks"], suggestion: sug(ENDPOINTS[2], 1), swagger: ENDPOINTS[2].source }),
      finding(5, { kind: "deprecated", severity: "warn", confidence: "high", repoId: "admin", site: site("admin", adminFile, 63, "window.swaggerClient.apis.Banks.deleteBank({ bankId })"), target: "DELETE /api/banks/{bankId}", swagger: ENDPOINTS[3].source }),
    ],
    usage: { "GET /api/banks": [site("admin", adminFile, 12, "getBanks")], "GET /api/banks/{bankId}": [site("admin", adminFile, 20, "getBank")], "POST /api/banks": [site("admin", adminFile, 30, "createBank")] },
    files: { [adminFile]: [6, 2, 3] },
  };
  const mobile: ClientReport = {
    repoId: "mobile",
    fingerprint: "0f1e2d3c4b5a-1a2b3c",
    cached: true,
    counts: { files: 553, calls: 4, matched: 3, errors: 1, warnings: 0, infos: 1 },
    findings: [
      finding(6, { kind: "method", severity: "error", confidence: "medium", repoId: "mobile", site: site("mobile", mobileFile, 31, "apiFetch(`/banks/${id}`, { method: 'PUT' })"), target: "PUT /banks/{}", allowed: ["GET", "DELETE"], swagger: ENDPOINTS[2].source }),
      finding(7, { kind: "responseField", severity: "info", confidence: "low", heuristic: true, repoId: "mobile", site: site("mobile", mobileFile, 12, "return order.total + order.ghostField;"), target: "GET /api/order/{orderId}", names: ["ghostField"], swagger: ENDPOINTS[4].source }),
      finding(8, { kind: "renamed", severity: "error", confidence: "medium", repoId: "mobile", site: site("mobile", mobileFile, 55, "apiFetch('/restaurant/list')"), target: "GET /restaurant/list", suggestion: sug(ENDPOINTS[6], 0.78) }),
    ],
    usage: { "GET /api/order/{orderId}": [site("mobile", mobileFile, 12, "apiFetch")], "POST /api/order/courier/labels": [site("mobile", mobileFile, 24, "apiFetch")] },
    files: { [mobileFile]: [4, 2, 0] },
  };
  return themed({
    fingerprint: "fixture",
    spec: { repoId: "backend", kind: "swagger2", title: "Happy API", version: "2.0.0", host: "https://api.example.test", files: ["src/api/swagger/bank.swagger.yaml", "src/api/swagger/order.swagger.yaml"], endpoints: ENDPOINTS.length, definitions: 2 },
    clients: [admin, mobile],
    unused: [ENDPOINTS[7], ENDPOINTS[6]].map((e) => ({ id: e.id, method: e.method, path: e.path, operationId: e.operationId, tags: e.tags, deprecated: e.deprecated, source: e.source })),
    endpoints: ENDPOINTS,
    definitions: ["Bank", "Order"],
  });
}

export function createMockContract(): ContractApi {
  const detailOf = (id: string): Detail => {
    const e = ENDPOINTS.find((x) => x.id === id) ?? ENDPOINTS[0];
    return themed({
      endpoint: e,
      description: e.summary ? `${e.summary}. Fixture description for the explorer.` : "",
      params: e.params.map((p) => ({ name: p.name, in: p.in, required: p.required, description: "", schema: node(p.type) })),
      request: e.hasBody ? BANK : null,
      consumes: e.hasBody ? ["application/json"] : [],
      responses: [
        { status: e.method === "POST" ? "201" : "200", description: "OK", schema: e.response ? (e.response.array ? node("array", { items: BANK }) : e.path.includes("order") ? ORDER : BANK) : null },
        { status: "403", description: "Forbidden", schema: null },
      ],
      secured: true,
    });
  };
  return {
    analyze: async () => themed(report()),
    detail: async (id) => detailOf(id),
    definition: async (name) => (name === "Order" ? ORDER : BANK),
  };
}
