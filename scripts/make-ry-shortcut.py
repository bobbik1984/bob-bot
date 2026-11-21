"""Build the credential-free Apple Shortcuts template. Sign the output on macOS."""
import argparse
import json
import plistlib
from pathlib import Path
from uuid import NAMESPACE_URL, uuid5

ROOT = Path(__file__).resolve().parents[1]


def build(origin):
    actions = []

    def action(kind, **params):
        uid = str(uuid5(NAMESPACE_URL, f"{origin}/shortcut/{len(actions)}/{kind}")).upper()
        actions.append({"WFWorkflowActionIdentifier": "is.workflow.actions." + kind,
                        "WFWorkflowActionParameters": {**params, "UUID": uid}})
        return {"Type": "ActionOutput", "OutputUUID": uid}

    def attachment(value):
        return {"WFSerializationType": "WFTextTokenAttachment", "Value": value}

    def string(prefix="", variable=None):
        value = {"string": prefix}
        if variable:
            value["string"] += "\ufffc"
            value["attachmentsByRange"] = {"{%d, 1}" % len(prefix): variable}
        return {"WFSerializationType": "WFTextTokenString", "Value": value}

    def fields(entries):
        items = [{"WFItemType": 0, "WFKey": string(key), "WFValue": value} for key, value in entries.items()]
        return {"WFSerializationType": "WFDictionaryFieldValue", "Value": {"WFDictionaryFieldValueItems": items}}

    def condition(value, code, **params):
        group = str(uuid5(NAMESPACE_URL, f"{origin}/if/{len(actions)}")).upper()
        action("conditional", GroupingIdentifier=group, WFControlFlowMode=0, WFCondition=code,
               WFInput={"Type": "Variable", "Variable": attachment(value)}, **params)
        return group

    def otherwise(group):
        action("conditional", GroupingIdentifier=group, WFControlFlowMode=1)

    def end(group):
        return action("conditional", GroupingIdentifier=group, WFControlFlowMode=2)

    def stop(message):
        action("showresult", Text=message)
        action("exit")

    source = {"Type": "ExtensionInput"}
    key = action("gettext", WFTextActionText="")
    # Compare the native type names on the device so a Chinese phone works in Chinese.
    sample = action("gettext", WFTextActionText="RY")
    plain_type = action("getitemtype", WFInput=attachment(sample))
    input_type = action("getitemtype", WFInput=attachment(source))
    group = condition(input_type, 4, WFConditionalActionString=string(variable=plain_type))
    action("detect.text", WFInput=attachment(source))
    otherwise(group)
    action("extracttextfromimage", WFImage=attachment(source))
    text = end(group)
    group = condition(text, 101)  # has no value
    stop("没有可读取的文字。请复制微信消息，或分享一张文字清晰的截图。")
    end(group)
    group = condition(text, 4, WFConditionalActionString=string(variable=key))
    stop("剪贴板里还是连接码。请先复制一条微信消息。")
    end(group)
    receipt = action("downloadurl", WFURL=origin + "/api/ingest", WFHTTPMethod="POST", WFHTTPBodyType="Form",
                     WFHTTPHeaders=fields({"Authorization": string("Bearer ", key)}),
                     WFFormValues=fields({"text": string(variable=text), "source": string("iphone-ry"),
                                          "instruction": string("提取聊天里明确需要跟进的待办，用原文确定期限。没有明确行动或有多件无关事项时留待确认。")}))
    task = action("getvalueforkey", WFInput=attachment(receipt), WFDictionaryKey="task_id")
    group = condition(task, 100)  # has any value
    action("notification", WFNotificationActionTitle="RY 已收件", WFNotificationActionBody="可在「文员 → 微信收件箱」查看待办和待确认事项。")
    otherwise(group)
    action("showresult", Text="RY 没有确认收件。请检查网络和安装时填写的连接码。")
    end(group)
    return {"WFWorkflowClientVersion": "3030.0.4", "WFWorkflowMinimumClientVersion": 900,
            "WFWorkflowMinimumClientVersionString": "900", "WFWorkflowName": "交给 RY",
            "WFWorkflowIcon": {"WFWorkflowIconStartColor": 463140863, "WFWorkflowIconGlyphNumber": 61440},
            "WFWorkflowTypes": ["ActionExtension"], "WFWorkflowHasShortcutInputVariables": True,
            "WFWorkflowInputContentItemClasses": ["WFStringContentItem", "WFImageContentItem"],
            "WFWorkflowNoInputBehavior": {"Name": "WFWorkflowNoInputBehaviorGetClipboard"},
            "WFWorkflowImportQuestions": [{"Category": "Parameter", "ActionIndex": 0, "ParameterKey": "WFTextActionText",
                                           "Text": "粘贴 RY 微信收件箱里的连接码（仅首次安装填写）", "DefaultValue": ""}],
            "WFWorkflowActions": actions}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    origin = json.loads((ROOT / "release-ry.json").read_text(encoding="utf-8"))["origin"]
    args.output.write_bytes(plistlib.dumps(build(origin), fmt=plistlib.FMT_XML, sort_keys=False))
