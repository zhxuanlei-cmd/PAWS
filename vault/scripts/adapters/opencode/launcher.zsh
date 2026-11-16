#!/bin/zsh
set -euo pipefail

# 独立分发目录经由 symlink 安装，使用脚本真实位置定位配套 vault。
readonly launcher_path="${0:A}"
readonly launcher_dir="${launcher_path:h}"
readonly vault_dir="${VAULT_DIR:-${launcher_dir:h:h:h}}"
readonly device_config="${PAWS_DEVICE_CONFIG:-$HOME/.config/paws-oss/device.json}"
# 内联覆盖位于原生配置的高优先级；所有入口（包括帮助）均拒绝外部预置覆盖。
if [[ -n "${OPENCODE_CONFIG_CONTENT:-}" || -n "${OPENCODE_PERMISSION:-}" || \
      -n "${OPENCODE_CONFIG:-}" || -n "${OPENCODE_CONFIG_DIR:-}" || \
      -n "${PAWS_OPENCODE_CONFIG:-}" || -n "${PAWS_OPENCODE_CWD:-}" || \
      -n "${PAWS_OPENCODE_EDIT_POLICY:-}" || -n "${OPENCODE_PURE:-}" ]]; then
  print -u2 "OpenCode PAWS launcher refuses pre-set configuration overrides or PAWS runtime context that could bypass the project policy overlay."
  exit 78
fi
# 优先使用显式原生程序路径及设备 pin，最后使用原生 opencode 的 PATH 入口。
# launcher 安装为 paws-opencode，保留原生命令及认证。读取设备映射只提取路径字段。
real_bin="${OPENCODE_REAL_BIN:-}"
engine_root="${vault_dir:h}/engine"
if [[ -f "$device_config" ]]; then
  if ! device_pins="$(python3 - "$device_config" <<'PY'
import json
from pathlib import Path
import sys

try:
    data = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
    if data.get('schema_version') != 1 or data.get('managed_by') != 'paws_setup':
        raise ValueError('device schema invalid')
    for value in (data.get('opencode_real_bin', ''), data.get('paths', {}).get('paws_control') or ''):
        if not isinstance(value, str) or (value and not Path(value).is_absolute()) or any(ord(c) < 32 for c in value):
            raise ValueError('device path invalid')
        print(value or '-')
except (AttributeError, OSError, TypeError, ValueError):
    print('OpenCode PAWS device map is invalid.', file=sys.stderr)
    sys.exit(1)
PY
)"; then
    exit 78
  fi
  pins=("${(@f)device_pins}")
  if [[ -z "$real_bin" && "${pins[1]}" != - ]]; then real_bin="${pins[1]}"; fi
  if [[ "${pins[2]}" != - ]]; then engine_root="${pins[2]}"; fi
fi
if [[ -z "$real_bin" ]]; then real_bin="$(whence -p opencode || true)"; fi
if [[ "$real_bin" != /* || ! -f "$real_bin" || ! -x "$real_bin" || "${real_bin:A}" == "$launcher_path" ]]; then
  print -u2 "OpenCode requires an executable native binary on PATH or an absolute OPENCODE_REAL_BIN."
  exit 127
fi
real_bin="${real_bin:A}"

# 仅四种精确单参数查询无须项目策略与凭据；debug 等命令不属于该入口。
# 混合参数直接拒绝，避免帮助选项掩盖模型、目录或实际业务动作。
if [[ $# == 1 ]]; then
  case "$1" in
    --help|-h|--version|-v) exec "$real_bin" "$@" ;;
  esac
fi
for argument in "$@"; do
  case "$argument" in
    --pure|--pure=*)
      print -u2 "OpenCode PAWS launcher requires its policy plugin; --pure is not supported."
      exit 78 ;;
    --help|-h|--version|-v)
      print -u2 "OpenCode help/version must be used as a single argument."
      exit 78 ;;
  esac
done

# 使用显式 Engine 程序，或在可复现构建后用 Node 运行配套 CLI。
if [[ -n "${PAWS_BIN:-}" ]]; then
  if [[ ! -x "$PAWS_BIN" ]]; then
    print -u2 "PAWS_BIN must identify an executable PAWS CLI."
    exit 78
  fi
  paws_command=("$PAWS_BIN")
else
  engine_cli="$engine_root/dist/src/cli.js"
  if [[ ! -r "$engine_cli" ]] || ! command -v node >/dev/null; then
    print -u2 "Build the bundled Engine or set PAWS_BIN before using paws-opencode."
    exit 78
  fi
  paws_command=(node "$engine_cli")
fi

# 只提取影响授权与凭据依赖的目录、显式模型和角色，保留原始参数供原生 CLI 解释。
# 不完整/紧缩写法明确失败，防止校验所见模型与原生实际选择不一致。
launch_cwd="$PWD"
requested_model=""
requested_model_seen=0
requested_agent=""
previous=""
for argument in "$@"; do
  if [[ "$previous" == "--dir" ]]; then
    launch_cwd="$argument"
    previous=""
    continue
  fi
  if [[ "$previous" == "--model" || "$previous" == "-m" ]]; then
    requested_model="$argument"
    requested_model_seen=1
    previous=""
    continue
  fi
  if [[ "$previous" == "--agent" ]]; then
    requested_agent="$argument"
    if [[ -z "$requested_agent" ]]; then
      print -u2 "OpenCode agent requires a nonempty value."
      exit 78
    fi
    previous=""
    continue
  fi
  case "$argument" in
    --dir|--model|-m|--agent) previous="$argument" ;;
    --dir=*) launch_cwd="${argument#--dir=}" ;;
    --model=*) requested_model="${argument#--model=}"; requested_model_seen=1 ;;
    --agent=*)
      requested_agent="${argument#--agent=}"
      if [[ -z "$requested_agent" ]]; then
        print -u2 "OpenCode agent requires a nonempty value."
        exit 78
      fi ;;
    -m?*)
      print -u2 "OpenCode model must use --model VALUE or -m VALUE."
      exit 78 ;;
  esac
done
if [[ -n "$previous" ]]; then
  print -u2 "OpenCode option requires a value: $previous"
  exit 78
fi
if [[ $# -gt 0 && "$1" != -* && -d "$1" ]]; then
  launch_cwd="$1"
fi
if [[ ! -d "$launch_cwd" ]]; then
  print -u2 "OpenCode working directory does not exist: $launch_cwd"
  exit 78
fi
launch_cwd="$(cd "$launch_cwd" && pwd -P)"

# 核对原生配置中的模型和配套合并 hook。普通 OpenCode 仍可按原生方式启动；
# PAWS 路径需要该 hook 对原生合并产生的本地权限再执行一次限制。
readonly default_config_home="$HOME/.config"
if [[ -n "${XDG_CONFIG_HOME:-}" && ("$XDG_CONFIG_HOME" != /* ||
      "${XDG_CONFIG_HOME:A}" != "${default_config_home:A}") ]]; then
  print -u2 "The PAWS OpenCode adapter uses ~/.config/opencode; XDG_CONFIG_HOME points elsewhere. Use the default location or run native OpenCode."
  exit 78
fi
readonly opencode_dir="$default_config_home/opencode"
readonly active_config="$opencode_dir/opencode.json"
readonly plugin="$opencode_dir/plugins/paws-tools.ts"
readonly bundled_plugin="$vault_dir/scripts/adapters/opencode/paws-tools.ts"
if [[ ! -f "$plugin" || "${plugin:A}" != "${bundled_plugin:A}" ]]; then
  print -u2 "The OpenCode PAWS plugin is missing from the active configuration directory."
  exit 78
fi
if ! baseline_provider="$(python3 - "$active_config" "$requested_agent" "$requested_model" <<'PY'
import json
from pathlib import Path
import re
import sys

try:
    config = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
    agent = sys.argv[2] or config.get('default_agent') or 'build'
    pinned = (config.get('agent') or {}).get(agent, {}).get('model')
    model = config.get('model') or pinned or sys.argv[3]
    if not isinstance(model, str) or not re.fullmatch(r'[a-z0-9][a-z0-9_-]*/[^/\x00-\x1f]+', model):
        raise ValueError('model invalid')
    print(model.split('/', 1)[0])
except (AttributeError, OSError, TypeError, ValueError):
    print('OpenCode PAWS needs a valid provider/model in the native config or explicit model selection.', file=sys.stderr)
    sys.exit(1)
PY
)"; then
  exit 78
fi

# 在启动前只解析一次实际目录、工作区和项目策略；认证由 OpenCode 自身管理。
if ! runtime_overlay="$("${paws_command[@]}" opencode runtime-overlay --vault "$vault_dir" --cwd "$launch_cwd" --baseline-provider "$baseline_provider")"; then
  exit 78
fi
if ! authorized_providers="$(print -rn -- "$runtime_overlay" | python3 -c '
import json, re, sys
try:
    data = json.load(sys.stdin)
    providers = data.get("enabled_providers") if isinstance(data, dict) else None
    if not isinstance(providers, list) or not providers or not all(
            isinstance(name, str) and re.fullmatch(r"[a-z0-9][a-z0-9_-]*", name) for name in providers):
        raise ValueError("runtime overlay has no valid authorized provider list")
    print(",".join(providers))
except (ValueError, TypeError) as error:
    print("OpenCode policy snapshot is invalid: " + str(error), file=sys.stderr)
    sys.exit(1)
')"; then
  exit 78
fi

# 查询仅访问本次内存快照，不再重复调用 provider-check 或解析项目文件。
provider_allowed() {
  [[ ",${authorized_providers}," == *",$1,"* ]]
}

if [[ "$requested_model_seen" == 1 ]]; then
  if [[ -z "$requested_model" || "$requested_model" != */* || "$requested_model" == /* || "$requested_model" == */ ]]; then
    print -u2 "OpenCode model must use provider/model."
    exit 78
  fi
  requested_provider="${requested_model%%/*}"
  if ! provider_allowed "$requested_provider"; then
    print -u2 "OpenCode provider is not authorized for this project: $requested_provider"
    exit 78
  fi
fi

# 校验显式模型、选中角色与固定辅助模型依赖，不读取或传递额外的凭据值。
if ! model_dependencies="$(print -rn -- "$runtime_overlay" | python3 -c '
import json, re, sys
from pathlib import Path

def merge(base, override):
    """只合并已持有的两个对象；不扫描凭据或重做原生项目配置加载。"""
    if not isinstance(base, dict) or not isinstance(override, dict):
        return override
    result = dict(base)
    for key, value in override.items():
        result[key] = merge(result[key], value) if key in result else value
    return result

try:
    active = json.loads(Path(sys.argv[1]).read_text())
    overlay = json.load(sys.stdin)
    if not isinstance(active, dict) or not isinstance(overlay, dict):
        raise ValueError("configuration must be an object")
    config = merge(active, overlay)
    agents = config.get("agent") or {}
    selected = sys.argv[3] or config.get("default_agent") or "build"
    if not isinstance(selected, str) or any(ord(c) < 32 for c in selected):
        raise ValueError("invalid selected agent")
    owner = agents.get(selected, {})
    if owner.get("disable"):
        raise ValueError("selected agent is disabled")
    required = {}

    def require(model, source):
        """记录 provider 与字段名；认证由 OpenCode 自身处理，不输出配置正文。"""
        if not isinstance(model, str) or "/" not in model:
            raise ValueError("missing or invalid model in " + source)
        provider, name = model.split("/", 1)
        if not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", provider) or not name or any(ord(c) < 32 for c in name):
            raise ValueError("invalid model in " + source)
        required.setdefault(provider, []).append(source)

    if sys.argv[2]:
        require(sys.argv[2], "--model")
    elif owner.get("model"):
        require(owner["model"], "agent." + selected + ".model")
    else:
        require(config.get("model"), "model")
    if config.get("small_model"):
        require(config["small_model"], "small_model")
    for name in ("title", "compaction"):
        helper = agents.get(name, {})
        if name == "compaction" and (config.get("compaction") or {}).get("auto") is False:
            continue
        if not helper.get("disable") and helper.get("model"):
            require(helper["model"], "agent." + name + ".model")
    print("@agent\t" + selected)
    for provider, sources in required.items():
        print(provider + "\t" + ", ".join(sources))
except (ValueError, TypeError, AttributeError, OSError):
    print("OpenCode cannot determine model credential dependencies from active config and policy; check model, small_model and selected agent fields.", file=sys.stderr)
    sys.exit(1)
' "$active_config" "$requested_model" "$requested_agent")"; then
  exit 78
fi
typeset -A required_reasons
while IFS=$'\t' read -r dependency_provider dependency_reason; do
  if [[ "$dependency_provider" == "@agent" ]]; then
    selected_agent="$dependency_reason"
  else
    required_reasons[$dependency_provider]="$dependency_reason"
  fi
done <<< "$model_dependencies"
for dependency_provider in "${(@k)required_reasons}"; do
  if ! provider_allowed "$dependency_provider"; then
    print -u2 "OpenCode provider is not authorized for this project: $dependency_provider (required by ${required_reasons[$dependency_provider]})."
    exit 78
  fi
done

# 使用同一授权快照作手动工作流限制与 provider 收窄；回调失败由 set -e/pipefail 阻止启动。
# 全局配置与附加项目配置由原生合并；--config 此处只指向实际全局配置进行预检。
launch_bundle="$(print -rn -- "$runtime_overlay" |
  python3 "$vault_dir/scripts/paws_manual_policy.py" overlay --vault "$vault_dir" --cwd "$launch_cwd" \
    --config "$active_config" --available-providers "$authorized_providers" --selected-agent "$selected_agent" --split-edit)"
# edit 单独传给最终配置钩子，避免内联覆盖先抹去项目已有的同键 deny/ask。
# 每个 JSON 均编码为单行；解析失败会在启动原生进程前退出。
launch_parts=("${(@f)$(print -rn -- "$launch_bundle" | python3 -c '
import json, sys
bundle = json.load(sys.stdin)
for name in ("config", "edit_policy"):
    value = bundle.get(name) if isinstance(bundle, dict) else None
    if not isinstance(value, dict):
        raise ValueError("OpenCode launch bundle is missing " + name)
    print(json.dumps(value, ensure_ascii=False))
')}")
if [[ ${#launch_parts} != 2 ]]; then
  print -u2 "OpenCode launch bundle must contain config and edit_policy."
  exit 78
fi
export OPENCODE_CONFIG_CONTENT="${launch_parts[1]}"
export PAWS_OPENCODE_EDIT_POLICY="${launch_parts[2]}"
export PAWS_OPENCODE_CONFIG="$active_config"
export PAWS_OPENCODE_CWD="$launch_cwd"
export VAULT_DIR="$vault_dir"
exec "$real_bin" "$@"
