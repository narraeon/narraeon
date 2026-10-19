import { expect, test } from "vitest";
import {
  parseWorkspaceHash,
  workspaceHash,
  type WorkspaceLocation,
} from "../../src/web/WorkspaceLocation.ts";

test.each<WorkspaceLocation>([
  { screen: "home" },
  { screen: "create" },
  { screen: "model" },
  { screen: "preview" },
  { screen: "plays" },
  { screen: "plays", presetId: "local-preset" },
  { screen: "content", packageId: "包 / % # ?" },
  { screen: "world", worldId: "world / % # ?" },
])("地址往返保留页面与本地身份：%j", (location) => {
  expect(parseWorkspaceHash(workspaceHash(location))).toEqual(location);
});

test("没有内容包身份的地址仍表达缺失目标，不回退为创建操作", () => {
  expect(parseWorkspaceHash("#/content")).toEqual({
    screen: "content",
    packageId: "",
  });
  expect(parseWorkspaceHash("#/content/%E0%A4%A")).toEqual({
    screen: "content",
    packageId: "",
  });
});

test.each(["#/unknown", "#/world/id/details", "#/content/id/extra"])(
  "拒绝不支持的页面与子视图：%s",
  (hash) => expect(parseWorkspaceHash(hash)).toBeNull(),
);
