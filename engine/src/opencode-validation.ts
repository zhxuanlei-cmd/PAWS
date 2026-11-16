/** OpenCode 配置的只读校验与摘要；不生成、不修复、不写入用户配置。 */
import {existsSync, readFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {Ajv2020} from "ajv/dist/2020.js";
import {assertNoLikelySecret} from "./security.js";

export interface OpenCodeConfigSummary {
  model: string;
  smallModel: string;
  defaultAgent: string;
  agentIds: string[];
  mcpIds: string[];
  pluginIds: string[];
  share: string;
  serverHostname: string;
  serverMdns: boolean;
  providerIds: string[];
}

type JsonObject = Record<string, unknown>;

/** 非对象或数组视为缺失的对象字段。 */
function object(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

/** 收集用户配置中显式声明的模型，补充宿主目录的已知集合。 */
function customModelReferences(config: JsonObject): string[] {
  const references: string[] = [];
  for (const [providerId, providerValue] of Object.entries(object(config.provider))) {
    for (const modelId of Object.keys(object(object(providerValue).models))) {
      references.push(`${providerId}/${modelId}`);
    }
  }
  return references;
}

/** 收集默认模型与各角色模型引用，忽略未配置项。 */
function configuredModelReferences(config: JsonObject): string[] {
  const references = [config.model, config.small_model];
  for (const agent of Object.values(object(config.agent))) references.push(object(agent).model);
  return references.filter((value): value is string => typeof value === "string" && value.length > 0);
}

/** 核对模型引用、默认主角色与自定义变体；不推断新的角色或模型。 */
function validateModelSemantics(config: JsonObject, knownModels?: Set<string>): void {
  for (const reference of configuredModelReferences(config)) {
    if (!reference.includes("/")) throw new Error(`OpenCode model reference must be provider/model: ${reference}`);
    if (knownModels && !knownModels.has(reference)) throw new Error(`OpenCode model reference is not available: ${reference}`);
  }
  const configuredAgents = object(config.agent);
  const defaultAgentId = typeof config.default_agent === "string" ? config.default_agent : undefined;
  if (defaultAgentId) {
    const defaultAgent = object(configuredAgents[defaultAgentId]);
    if (Object.keys(defaultAgent).length === 0) throw new Error(`OpenCode default_agent is not configured: ${defaultAgentId}`);
    if (!["primary", "all"].includes(String(defaultAgent.mode ?? ""))) {
      throw new Error(`OpenCode default_agent must use mode primary or all: ${defaultAgentId}`);
    }
  }
  const configuredProviders = object(config.provider);
  for (const [agentId, agentValue] of Object.entries(configuredAgents)) {
    const agent = object(agentValue);
    if (typeof agent.variant !== "string" || typeof agent.model !== "string") continue;
    const separator = agent.model.indexOf("/");
    if (separator < 1) continue;
    const providerId = agent.model.slice(0, separator);
    const modelId = agent.model.slice(separator + 1);
    const model = object(object(object(configuredProviders[providerId]).models)[modelId]);
    if (Object.keys(model).length === 0) continue; // 原生模型的变体由宿主目录检查，本地只检查显式声明的自定义变体。
    const variants = object(model.variants);
    if (!Object.hasOwn(variants, agent.variant)) {
      throw new Error(`OpenCode agent ${agentId} selects unknown custom variant ${agent.variant} for ${agent.model}`);
    }
  }
}

/** 沿用已批准的 LSP 合同，仅检查现状，不启动语言服务。 */
function validateLspSemantics(config: JsonObject): void {
  const value = config.lsp;
  const enabled = value === true || (value !== null && typeof value === "object" && !Array.isArray(value));
  if (!enabled) {
    throw new Error("PAWS OpenCode config must enable LSP with lsp=true or an LSP configuration object");
  }
}

/** 只读核对凭据引用、现行 PAWS 合同和指定 JSON Schema；失败抛出异常。 */
export function validateOpenCodeConfig(config: JsonObject, schemaPath: string): void {
  const source = JSON.stringify(config);
  assertNoLikelySecret(source, "OpenCode config");
  const providers = object(config.provider);
  for (const [providerId, providerValue] of Object.entries(providers)) {
    const apiKey = object(object(providerValue).options).apiKey;
    if (typeof apiKey !== "string" || !/^\{env:[A-Z][A-Z0-9_]*\}$/.test(apiKey)) {
      throw new Error(`provider ${providerId} must use an {env:NAME} apiKey reference`);
    }
  }
  const plugins = Array.isArray(config.plugin) ? config.plugin.map(String) : [];
  if (plugins.some((plugin) => /oh-my-openagent|claude-mem/i.test(plugin))) {
    throw new Error("removed plugin must not be restored");
  }
  validateLspSemantics(config);
  const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as object;
  const ajv = new Ajv2020({strict: false, allErrors: true, validateFormats: false});
  const modelSchemaPath = join(dirname(schemaPath), "model-schema.json");
  let knownModels: Set<string> | undefined;
  if (existsSync(modelSchemaPath)) {
    const modelSchema = JSON.parse(readFileSync(modelSchemaPath, "utf8")) as JsonObject;
    const modelDefinition = object(object(modelSchema["$defs"]).Model);
    const catalogModels = Array.isArray(modelDefinition.enum) ? modelDefinition.enum.map(String) : [];
    const extendedModels = [...new Set([...catalogModels, ...customModelReferences(config)])];
    modelDefinition.enum = extendedModels;
    knownModels = new Set(extendedModels);
    ajv.addSchema(modelSchema);
  }
  validateModelSemantics(config, knownModels);
  const validate = ajv.compile(schema);
  if (!validate(config)) {
    throw new Error(`OpenCode schema validation failed: ${ajv.errorsText(validate.errors, {separator: "; "})}`);
  }
}

/** 返回无凭据值的结构摘要；不返回 provider options 或提示词正文。 */
export function summarizeOpenCodeConfig(config: JsonObject): OpenCodeConfigSummary {
  const server = object(config.server);
  return {
    model: String(config.model ?? ""),
    smallModel: String(config.small_model ?? ""),
    defaultAgent: String(config.default_agent ?? ""),
    agentIds: Object.keys(object(config.agent)).sort(),
    mcpIds: Object.keys(object(config.mcp)).sort(),
    pluginIds: (Array.isArray(config.plugin) ? config.plugin.map(String) : []).sort(),
    share: String(config.share ?? ""),
    serverHostname: String(server.hostname ?? ""),
    serverMdns: server.mdns === true,
    providerIds: Object.keys(object(config.provider)).sort()
  };
}

/** 只读加载 JSON 对象，并拒绝疑似明文凭据。 */
export function readOpenCodeConfig(path: string): JsonObject {
  const source = readFileSync(path, "utf8");
  assertNoLikelySecret(source, path);
  const value = JSON.parse(source) as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`OpenCode config must be an object: ${path}`);
  return value as JsonObject;
}
