import { readdir, readFile, stat } from "node:fs/promises";
import { test, expect } from "@playwright/test";
import * as OTPAuth from "otpauth";
test("owner signup → TOTP → settings → real worker dry-run → logout/login, on desktop and phone", async ({
  page,
  browser,
}) => {
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await page.getByLabel("Ngôn ngữ").selectOption("en");
  await page.getByLabel("Your name").fill("Dio");
  await page.getByLabel("Business name").fill("Helpa demo seafood");
  await page
    .getByLabel("Setup token")
    .fill("e2e-fixture-bootstrap-0123456789-0123456789");
  await page.getByLabel("Email address").fill("e2e-owner@example.org");
  await page.getByLabel("Password", { exact: true }).fill("e2e-password-123!");
  await page.getByRole("button", { name: "Create owner account" }).click();
  // Persisted user locale defaults to Vietnamese on initial signup.
  await expect(page.getByLabel("Xác nhận mật khẩu")).toBeVisible();
  await page.getByLabel("Ngôn ngữ").selectOption("en");
  await page.getByLabel("Confirm your password").fill("e2e-password-123!");
  const response = page.waitForResponse((r) =>
    r.url().endsWith("/api/auth/two-factor/enable"),
  );
  await page.getByRole("button", { name: "Set up authenticator" }).click();
  const enrollment = await (await response).json();
  const totp = OTPAuth.URI.parse(enrollment.totpURI) as OTPAuth.TOTP;
  await page.getByLabel("I saved my recovery codes").check();
  await page.getByLabel("6-digit authenticator code").fill(totp.generate());
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await expect(
    page.getByRole("button", { name: "Tổng quan", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Ngôn ngữ").selectOption("en");
  await expect(
    page.getByRole("heading", { name: "A clear view of your back office." }),
  ).toBeVisible();
  await page.screenshot({
    path: ".local/helpa-overview-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Provider", { exact: true }).selectOption("openai");
  await page.getByLabel("Monthly cap (USD)").fill("25");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Saved");
  await page.getByRole("button", { name: "System", exact: true }).click();
  const retry = page.getByRole("button", {
    name: "Retry failed event",
    exact: true,
  });
  await expect(retry).toBeVisible();
  await retry.click();
  await expect(retry).toHaveCount(0);
  await expect
    .poll(async () => {
      const system = await page.request.get("/api/system");
      return (await system.json()).webhooks.recovery.length;
    })
    .toBe(0);

  await page
    .getByRole("button", { name: "Verify dry-run", exact: true })
    .click();
  await expect(page.getByText("Would have sent", { exact: true })).toBeVisible({
    timeout: 20000,
  });
  await expect(page.locator(".operation pre")).toContainText(
    "Helpa dry-run check",
  );
  await expect(page.locator(".operation pre")).toContainText(
    "Asia/Ho_Chi_Minh",
  );
  await page.getByRole("button", { name: "Audit trail", exact: true }).click();
  await expect(
    page.getByText("outbound.would_have_sent", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Media", exact: true }).click();
  await page
    .getByLabel("Upload image or video (100 MB default limit)")
    .setInputFiles(".local/publisher-fixture.mp4");
  await expect(
    page.locator(".media-card").getByText("ready", { exact: true }),
  ).toBeVisible({ timeout: 20000 });
  await page
    .getByRole("button", { name: "Calendar & posts", exact: true })
    .click();
  await page.getByRole("button", { name: "New post", exact: true }).click();
  await page.getByLabel("Internal title").fill("Arrival Reel — fixture");
  await page
    .getByLabel("Channel", { exact: true })
    .selectOption({ label: "Fixture Facebook · facebook" });
  await page.getByLabel("Format", { exact: true }).selectOption("reel");
  await page
    .getByLabel("Caption", { exact: true })
    .fill("Hàng mới về. Fixture dry-run only.");
  await page.getByLabel(/publisher-fixture.mp4/).check();
  const local = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 16);
  await page.getByLabel("Publish time · Asia/Ho_Chi_Minh").fill(local);
  await page
    .getByRole("button", { name: "Save revision", exact: true })
    .click();
  await expect(page.locator(".post-card")).toContainText("Approval required");
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.locator(".post-card")).toContainText("Would have sent", {
    timeout: 20000,
  });
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await expect(page.locator(".payload")).toContainText('"format": "reel"');
  await expect(page.locator(".payload")).toContainText('"sha256"');
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.screenshot({
    path: ".local/helpa-publisher-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Knowledge", exact: true }).click();
  await page.getByText("Add source", { exact: true }).click();
  await page.getByLabel("Source name").fill("Fixture product knowledge");
  await page
    .getByRole("button", { name: "Create source", exact: true })
    .click();
  await page.getByLabel("sku", { exact: true }).fill("T20");
  await page.getByLabel("name_vi", { exact: true }).fill("Tôm sú size 20");
  await page.getByLabel("aliases", { exact: true }).fill("tôm sú size 20");
  await page.getByLabel("price", { exact: true }).fill("320000");
  await page
    .getByRole("button", { name: "Approve & save record", exact: true })
    .click();
  await expect(page.getByText(/Saved 1 rows/)).toBeVisible();
  await page.getByRole("button", { name: "Inbox", exact: true }).click();
  await page
    .getByRole("button", { name: "Paste a manual inquiry", exact: true })
    .click();
  await page.getByLabel("Customer reference").fill("Fixture customer");
  await page
    .getByLabel("Customer message")
    .fill("Giá tôm sú size 20 bao nhiêu?");
  await page
    .getByRole("button", { name: "Create & analyze", exact: true })
    .click();
  await expect(page.getByLabel("Reply text to approve")).toBeVisible({
    timeout: 20000,
  });
  await page.getByText(/Facts & source versions/).click();
  await expect(
    page.locator(".fact-row").filter({ hasText: "price" }).first(),
  ).toContainText("320000");
  await page
    .getByLabel("Reply text to approve")
    .fill("Nhân viên đã nhận câu hỏi của anh/chị.");
  await page
    .getByRole("button", { name: "Approve this reply", exact: true })
    .click();
  await expect(page.locator(".draft-card .pill")).toContainText(
    "would_have_sent",
    { timeout: 20000 },
  );
  await page.screenshot({
    path: ".local/helpa-inbox-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Reports", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Audience & operations" }),
  ).toBeVisible();
  await expect(
    page.getByText("No platform snapshots yet. No history has been invented."),
  ).toBeVisible();
  await page.getByRole("button", { name: "7 days", exact: true }).click();
  await expect(page.locator(".report-kpis")).toContainText("Inquiries");
  await page.screenshot({
    path: ".local/helpa-reports-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: ".local/helpa-reports-mobile.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page
    .getByRole("button", { name: "Evidence & advice", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Refresh insights", exact: true })
    .click();
  await expect(
    page.getByText(/No supported recommendations yet/),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: ".local/helpa-overview-mobile.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Sign out", exact: true })
    .last()
    .click();
  await page.getByLabel("Email address").fill("e2e-owner@example.org");
  await page.getByLabel("Password", { exact: true }).fill("e2e-password-123!");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByLabel("6-digit authenticator code")).toBeVisible();
  await page
    .getByRole("button", { name: "Use a recovery code", exact: true })
    .click();
  await page
    .getByLabel("Recovery code", { exact: true })
    .fill(enrollment.backupCodes[0]);
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await expect(
    page.getByRole("heading", { name: "A clear view of your back office." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Team", exact: true }).click();
  await page.getByLabel("Member name").fill("Sister browser fixture");
  await page.getByLabel("Invite by").selectOption("phone");
  await page.getByLabel("Email or +84 phone").fill("+84912345678");
  await page
    .getByRole("button", { name: "Create invitation", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("Invitation saved");
  const guestContext = await browser.newContext();
  const guest = await guestContext.newPage();
  await guest.goto("/");
  await guest.getByLabel("Ngôn ngữ").selectOption("en");
  await guest.getByLabel("Sign-in method").selectOption("phone");
  await guest.getByLabel("Vietnam phone (+84)").fill("+84912345678");
  await guest
    .getByRole("button", { name: "Send sign-in link / code", exact: true })
    .click();
  await expect(guest.getByLabel("SMS verification code")).toBeVisible();
  const files = await Promise.all(
    (await readdir(".local/e2e-auth-outbox")).map(async (f) => ({
      data: JSON.parse(await readFile(".local/e2e-auth-outbox/" + f, "utf8")),
      time: (await stat(".local/e2e-auth-outbox/" + f)).mtimeMs,
    })),
  );
  const otpCode = files
    .filter((f) => f.data.phone === "+84912345678")
    .sort((a, b) => b.time - a.time)[0].data.code;
  await guest.getByLabel("SMS verification code").fill(otpCode);
  await guest
    .getByRole("button", { name: "Verify access", exact: true })
    .click();
  await expect(
    guest.getByRole("button", { name: "Hộp thư", exact: true }),
  ).toBeVisible();
  await guest.getByLabel("Ngôn ngữ").selectOption("en");
  await guest.getByRole("button", { name: "Inbox", exact: true }).click();
  await expect(
    guest.getByRole("heading", { name: "Customer inbox", exact: true }),
  ).toBeVisible();
  await expect(
    guest.getByRole("button", { name: "Team", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await page.getByRole("button", { name: "Team", exact: true }).click();
  const member = page
    .locator(".member-card")
    .filter({ hasText: "Sister browser fixture" });
  await member.getByText("Manage access", { exact: true }).click();
  await member
    .getByRole("button", { name: "Revoke access now", exact: true })
    .click();
  await expect(member).toContainText("Revoked");
  expect((await guestContext.request.get("/api/inbox")).status()).toBe(401);
  await guestContext.close();
  expect(failures).toEqual([]);
});
