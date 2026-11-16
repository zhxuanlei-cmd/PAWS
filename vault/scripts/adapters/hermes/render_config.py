#!/usr/bin/env python3
"""只读渲染 Hermes 原生配置的 PAWS 切片，由安装器统一备份、原子写入和回滚。

输入为标准输入中的 JSON：原 YAML、manifest 的 Hermes 设置和实际 HOME。
输出为 JSON 中的目标 YAML；不访问模型、凭据存储、会话或其他文件。
仅维护 skills.auto_load/external_dirs 与 quick_commands.start；其他语义和
其他顶层 YAML 字节保留，冲突、重复键、未知格式和缺少 PyYAML 均明确失败。
"""
import copy
import json
import sys

try:
    import yaml
except ImportError:
    print("需要 Python + PyYAML（可指定 PAWS_PYTHON）", file=sys.stderr)
    sys.exit(2)


class ConfigError(Exception):
    """错误消息仅包含固定类别，不含配置值或解析器原始输入。"""


class UniqueLoader(yaml.SafeLoader):
    """拒绝重复键和 YAML 合并键，避免静默选择某个权限/模型定义。"""


def unique_mapping(loader, node, deep=False):
    """构造单个映射；不允许重复或不可解析的键。"""
    result = {}
    for key_node, value_node in node.value:
        if key_node.tag == "tag:yaml.org,2002:merge":
            raise ConfigError("配置含 YAML 合并键，需先人工确认")
        key = loader.construct_object(key_node, deep=deep)
        if not isinstance(key, str) or key in result:
            raise ConfigError("配置含重复或非字符串键")
        result[key] = loader.construct_object(value_node, deep=deep)
    return result


UniqueLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, unique_mapping)


def append_list(mapping, key, item):
    """保留已有列表顺序，幂等加入一个同源入口；类型冲突不能降级为空列表。"""
    current = mapping.get(key, [])
    if not isinstance(current, list) or any(not isinstance(v, str) for v in current):
        raise ConfigError("PAWS 涉及的 skills 列表格式不兼容")
    mapping[key] = current if item in current else [*current, item]


def render(original, settings, home):
    """生成目标文本并校验语义，仅修改两个明确授权的顶层配置块。"""
    data = yaml.load(original, Loader=UniqueLoader) or {}
    if not isinstance(data, dict):
        raise ConfigError("Hermes 配置根必须是映射")
    desired = copy.deepcopy(data)
    for section in ("skills", "quick_commands"):
        if section not in desired:
            desired[section] = {}
        if not isinstance(desired[section], dict):
            raise ConfigError("PAWS 涉及的配置块格式不兼容")
    append_list(desired["skills"], "auto_load", settings["bootstrap_skill"])
    # 工作区自带的 Skills 已显式接线；仅显式配置外部目录时才加入现有列表。
    if settings.get("external_skills"):
        external = settings["external_skills"].replace("$HOME", home, 1)
        append_list(desired["skills"], "external_dirs", external)
    for command, target in settings["aliases"].items():
        alias = {"type": "alias", "target": target}
        current = desired["quick_commands"].get(command)
        # Desktop 自行补斜杠，CLI/gateway 兼容有无斜杠；旧等价写法可幂等规范化。
        equivalent = {"type": "alias", "target": "/" + target.lstrip("/")}
        if current is not None and current not in (alias, equivalent):
            raise ConfigError("已有同名 quick command；未覆盖，请核对冲突")
        desired["quick_commands"][command] = alias
    if desired == data:
        return original

    # 利用 YAML 节点的字节位置替换受影响块；其余配置和注释原字节保留。
    document = yaml.compose(original)
    spans = {}
    if document is not None:
        if not isinstance(document, yaml.MappingNode):
            raise ConfigError("Hermes 配置节点不是映射")
        spans = {key.value: (key.start_mark.index, value.end_mark.index)
                 for key, value in document.value}
    patches, added = [], []
    for section in ("skills", "quick_commands"):
        if data.get(section) == desired[section]:
            continue
        block = yaml.safe_dump({section: desired[section]}, allow_unicode=True, sort_keys=False)
        if section in spans:
            begin, end = spans[section]
            patches.append((begin, end, block))
        else:
            added.append(block)
    result = original
    for begin, end, block in sorted(patches, reverse=True):
        result = result[:begin] + block + result[end:]
    if added:
        result = result.rstrip("\n") + "\n\n" + "\n".join(added)
    if yaml.load(result, Loader=UniqueLoader) != desired:
        raise ConfigError("渲染后语义不一致，未安装")
    return result


def main():
    """渲染失败不输出原配置；成功结果仅供父安装进程内存使用。"""
    try:
        request = json.load(sys.stdin)
        content = render(request["original"], request["settings"], request["home"])
        print(json.dumps({"content": content}, ensure_ascii=False))
    except ConfigError as error:
        print(str(error), file=sys.stderr)
        return 2
    except Exception:
        print("配置解析或输入合同错误；未输出配置正文", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
