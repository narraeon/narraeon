import { expect } from "@playwright/test";
import {
  chatGptUsageUrl,
  type ChatGptAccount,
} from "../../src/protocol/chatGptAuth.ts";
import type {
  ModelConnectionLibraryView,
  ModelConnectionView,
} from "../../src/protocol/modelConnections.ts";
import type { V1Request } from "../../src/protocol/v1.ts";
import { v1Protocol } from "../../src/protocol/v1Version.ts";
import { test } from "../support/isolatedRuntimeTest.ts";

test.use({ runtimeScope: "chatgpt-model-connection" });

for (const locale of ["zh-CN", "en"] as const) {
  test(`shows ChatGPT consent, account catalog, probe costs, and disconnect in ${locale}`, async ({
    page,
  }) => {
    const t = (zh: string, en: string) => (locale === "zh-CN" ? zh : en);
    const account: ChatGptAccount = {
      id: "workspace-chatgpt-account",
      label: "Fixture account",
      email: "account@example.test",
      status: "signed_out",
    };
    const signInRequests: boolean[] = [];
    let probes = 0;
    let refreshes = 0;
    let saved: ModelConnectionView | undefined;
    await page.request.post("/api/runtime/v1", {
      data: {
        protocol: v1Protocol,
        request: { type: "preferences.save", locale },
      },
    });
    await page.route("**/api/runtime/v1", async (route) => {
      const request = (route.request().postDataJSON() as { request: V1Request })
        .request;
      const respond = (result: unknown) =>
        route.fulfill({ json: { protocol: v1Protocol, result } });
      if (
        request.type === "model.read" ||
        request.type === "workspace.read" ||
        request.type === "model.save"
      ) {
        if (request.type === "model.save") {
          const { connection } = request;
          expect(connection.apiKey).toBeUndefined();
          expect(connection.chatGptAccountId).toBe(account.id);
          saved = {
            ...connection,
            id: "plan-connection",
            dialect: "standard",
            reasoningEffort: "provider_default",
            reasoningSummary: "provider_default",
            thinkingMode: "provider_default",
            thinkingBudgetTokens: null,
            supportsAllowedTools: false,
            assistantPrefillMode: "disabled",
            hasApiKey: false,
          };
        }
        const response = await route.fetch({
          ...(request.type === "model.save"
            ? {
                postData: JSON.stringify({
                  protocol: v1Protocol,
                  request: { type: "model.read" },
                }),
              }
            : {}),
        });
        const { result } = (await response.json()) as {
          result:
            ModelConnectionLibraryView | { model: ModelConnectionLibraryView };
        };
        const library = {
          ...("model" in result ? result.model : result),
          chatGptAvailable: true,
          configured:
            saved !== undefined && account.status === "plan_authorized",
          activeConnectionId: saved?.id ?? null,
          connections: saved === undefined ? [] : [saved],
        };
        await respond(
          request.type === "workspace.read"
            ? { ...result, model: library }
            : library,
        );
      } else if (request.type === "model.chatgpt.accounts") {
        await respond(
          account.status === "signed_out" && saved === undefined
            ? []
            : [account],
        );
      } else if (request.type === "model.chatgpt.sign-in") {
        signInRequests.push(request.requestPlanConsent);
        if (request.requestPlanConsent)
          expect(request.accountId).toBe(account.id);
        await respond({ attemptId: `attempt-${signInRequests.length}` });
      } else if (request.type === "model.chatgpt.sign-in-status") {
        account.status =
          request.attemptId === "attempt-1" ? "signed_in" : "plan_authorized";
        await respond({ status: "completed", account });
      } else if (request.type === "model.chatgpt.models") {
        expect(account.status).toBe("plan_authorized");
        await respond([
          { id: "account-model", displayName: "Fixture plan model" },
        ]);
      } else if (request.type === "model.chatgpt.refresh") {
        refreshes++;
        await respond(account);
      } else if (request.type === "model.chatgpt.disconnect") {
        account.status = "signed_out";
        await respond({ account, remoteRevocationConfirmed: false });
      } else if (request.type === "model.test") {
        expect(request.connection.chatGptAccountId).toBe(account.id);
        expect(request.connection.modelId).toBe("account-model");
        probes++;
        await respond({ outcome: "quota" });
      } else {
        await route.continue();
      }
    });

    await page.goto("/#/models");
    const form = page.locator("form.config-form");
    await form.locator("#model-preset").selectOption("chatgpt-plan");
    const signIn = form.getByRole("button", {
      name: t("使用 ChatGPT 继续", "Continue with ChatGPT"),
    });
    await expect(signIn).toHaveAttribute("data-oai-siwc-button", "");
    const probe = form.getByRole("button", {
      name: t("试发一条消息", "Send a test message"),
    });
    const save = form.getByRole("button", {
      name: t("保存模型连接并启用", "Save and enable model connection"),
    });
    await expect(probe).toBeDisabled();
    await expect(save).toBeDisabled();
    await expect(form.getByLabel("API Key", { exact: true })).toHaveCount(0);
    await expect(form.getByLabel("Base URL", { exact: true })).toHaveCount(0);
    await signIn.click();
    await expect(
      form.getByText(
        t(
          "已登录 ChatGPT，尚未授权使用套餐",
          "Signed in to ChatGPT. Plan usage is awaiting authorization.",
        ),
      ),
    ).toBeVisible();
    await expect(
      form.getByLabel(t("ChatGPT 模型", "ChatGPT model")),
    ).toHaveCount(0);
    await form
      .getByRole("button", {
        name: t("授权使用 ChatGPT 套餐", "Enable ChatGPT plan usage"),
      })
      .click();
    const intro = page.getByRole("dialog", {
      name: t("你已授权使用 ChatGPT 套餐", "You’ve enabled ChatGPT plan usage"),
    });
    await expect(intro).toBeVisible();
    await expect(intro.getByRole("link")).toHaveAttribute(
      "href",
      chatGptUsageUrl,
    );
    await intro.getByRole("button", { name: t("知道了", "Got it") }).click();
    await expect(
      form.getByText(
        t("已授权使用 ChatGPT 套餐", "ChatGPT plan usage is authorized"),
      ),
    ).toBeVisible();
    const model = form.getByLabel(t("ChatGPT 模型", "ChatGPT model"), {
      exact: true,
    });
    await model.selectOption({ label: "Fixture plan model" });
    const followups = form.getByRole("checkbox", {
      name: t(
        "允许此连接在每轮游玩结束后自动发送额外请求，使用我的 ChatGPT 套餐或额度。",
        "Allow this connection to automatically send extra requests after each play turn using my ChatGPT plan or credits.",
      ),
    });
    await expect(followups).toHaveCount(0);
    await expect(probe).toHaveAccessibleDescription(
      t(
        "试发会发送一条短消息，使用你的 ChatGPT 套餐或额度。输出上限由 ChatGPT 决定。",
        "The test sends one short message using your ChatGPT plan or credits. ChatGPT sets the output limit.",
      ),
    );
    expect(probes).toBe(0);
    await probe.click();
    const quota = form.getByText(
      t(
        "ChatGPT 套餐或此应用的使用已达到上限。",
        "Your ChatGPT plan or this app has reached its usage limit.",
      ),
    );
    await expect(quota).toBeVisible();
    await expect(quota.getByRole("link")).toHaveAttribute(
      "href",
      chatGptUsageUrl,
    );
    expect(probes).toBe(1);
    expect(signInRequests).toEqual([false, true]);

    await save.click();
    await expect(
      page.locator(".model-active-summary").getByText("account-model"),
    ).toBeVisible();
    expect(saved).not.toHaveProperty("chatGptAllowFollowups");
    await page.reload();
    await expect(model).toHaveValue("account-model");
    await expect(followups).toHaveCount(0);
    await form
      .getByRole("button", {
        name: t("刷新 ChatGPT 授权", "Refresh ChatGPT authorization"),
      })
      .click();
    await expect(
      form.getByText(
        t("已刷新 ChatGPT 授权。", "ChatGPT authorization refreshed."),
      ),
    ).toBeVisible();
    expect(refreshes).toBe(1);
    await form
      .getByRole("button", {
        name: t("断开 ChatGPT 账号", "Disconnect ChatGPT account"),
      })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: t("断开", "Disconnect") })
      .click();
    await expect(
      form.getByText(t("已退出 ChatGPT", "Signed out of ChatGPT")),
    ).toBeVisible();
    await expect(probe).toBeDisabled();
    await expect(save).toBeDisabled();
    expect(probes).toBe(1);
  });
}
