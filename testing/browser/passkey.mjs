import assert from "node:assert/strict";
import { chromium } from "playwright";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const config = JSON.parse(input);
const browser = await chromium.launch({
  executablePath: process.env.PASSKEY_CHROMIUM_PATH || undefined,
});

try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  await page.goto(config.origin);
  const accessToken = await page.evaluate(async ({ citizenId, grant }) => {
    const check = (condition, message) => {
      if (!condition) throw new Error(message);
    };
    const request = async (
      path,
      body,
      token,
      method = "POST",
      headers = {},
    ) => {
      const response = await fetch(path, {
        method,
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
        ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, body: await response.json() };
    };
    const decode = (value) =>
      Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
        c.charCodeAt(0),
      );
    const encode = (value) =>
      btoa(String.fromCharCode(...new Uint8Array(value)))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
    const serialize = (credential) => {
      const response = {
        clientDataJSON: encode(credential.response.clientDataJSON),
      };
      for (const field of [
        "attestationObject",
        "authenticatorData",
        "signature",
        "userHandle",
      ]) {
        if (credential.response[field])
          response[field] = encode(credential.response[field]);
      }
      if (credential.response.getTransports)
        response.transports = credential.response.getTransports();
      return {
        id: credential.id,
        rawId: encode(credential.rawId),
        type: credential.type,
        response,
        clientExtensionResults: credential.getClientExtensionResults(),
        authenticatorAttachment: credential.authenticatorAttachment,
      };
    };

    check(
      window.isSecureContext && !!navigator.credentials,
      "WebAuthn needs a secure context",
    );
    check(
      (await request("/auth/validate", null, grant, "GET")).status === 401,
      "Enrollment grant must not authenticate",
    );
    const registration = await request(
      "/auth/passkeys/registration/begin",
      {},
      grant,
    );
    check(registration.status === 200, "Registration begin failed");
    check(
      (await request("/auth/passkeys/registration/begin", {}, grant)).status ===
        401,
      "Enrollment grant replay accepted",
    );
    const creation = registration.body.options.publicKey;
    creation.challenge = decode(creation.challenge);
    creation.user.id = decode(creation.user.id);
    creation.excludeCredentials = (creation.excludeCredentials ?? []).map(
      (c) => ({ ...c, id: decode(c.id) }),
    );
    const credential = serialize(
      await navigator.credentials.create({ publicKey: creation }),
    );
    const registered = await request(
      "/auth/passkeys/registration/finish",
      credential,
      registration.body.ceremony_token,
    );
    check(
      registered.status === 201 && !registered.body.access_token,
      "Enrollment must not issue a session",
    );
    check(
      (
        await request(
          "/auth/passkeys/registration/finish",
          credential,
          registration.body.ceremony_token,
        )
      ).status === 401,
      "Registration replay accepted",
    );

    const login = await request("/auth/passkeys/login/begin", {
      citizen_id: citizenId,
      device_fingerprint: "browser-fixture",
      ip_subnet: "local",
    });
    check(login.status === 200, "Login begin failed");
    const options = login.body.options.publicKey;
    options.challenge = decode(options.challenge);
    options.allowCredentials = options.allowCredentials.map((c) => ({
      ...c,
      id: decode(c.id),
    }));
    const assertion = serialize(
      await navigator.credentials.get({ publicKey: options }),
    );
    const logged = await request(
      "/auth/passkeys/login/finish",
      assertion,
      login.body.ceremony_token,
    );
    check(
      logged.status === 201 && logged.body.assurance_tier === "T3",
      "Verified passkey login must issue T3",
    );
    check(!logged.body.refresh_token, "Refresh token exposed in JSON");
    check(
      !document.cookie.includes("refresh_token"),
      "Refresh token exposed to browser scripts",
    );
    check(
      (
        await request(
          "/auth/passkeys/login/finish",
          assertion,
          login.body.ceremony_token,
        )
      ).status === 401,
      "Assertion replay accepted",
    );
    const validated = await request(
      "/auth/validate",
      null,
      logged.body.access_token,
      "GET",
    );
    check(
      validated.status === 200 &&
        validated.body.citizen_id === citizenId &&
        validated.body.assurance_tier === "T3",
      "Session validation failed",
    );
    const refreshed = await request("/auth/refresh", {}, null, "POST", {
      "X-Device-Fingerprint": "browser-fixture",
      "X-IP-Subnet": "local",
    });
    check(
      refreshed.status === 200 &&
        refreshed.body.access_token !== logged.body.access_token,
      "Browser refresh cookie or rotation failed",
    );
    check(
      (await request("/auth/validate", null, logged.body.access_token, "GET"))
        .status === 401,
      "Previous access token survived rotation",
    );
    return refreshed.body.access_token;
  }, config);

  // Cookie metadata is checked outside page JS: HttpOnly makes it unreadable there.
  const refreshCookie = (await context.cookies()).find(
    (cookie) => cookie.name === "refresh_token",
  );
  assert.ok(refreshCookie, "Browser did not retain the refresh cookie");
  assert.ok(
    refreshCookie.httpOnly && refreshCookie.secure,
    "Refresh cookie is not HttpOnly and Secure",
  );
  assert.equal(refreshCookie.sameSite, "Strict");
  assert.equal(refreshCookie.path, "/auth");
  await page.evaluate(async (token) => {
    const logout = await fetch("/auth/logout", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (logout.status !== 200) throw new Error("Logout failed");
    const validate = await fetch("/auth/validate", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (validate.status !== 401) throw new Error("Logged-out session survived");
    const refresh = await fetch("/auth/refresh", { method: "POST" });
    if (refresh.status !== 401)
      throw new Error("Logged-out browser can refresh");
  }, accessToken);
  assert.equal(
    (await context.cookies()).filter(
      (cookie) => cookie.name === "refresh_token",
    ).length,
    0,
  );
  console.log(
    "Browser passkey enrollment, login, replay, refresh and logout checks passed.",
  );
} finally {
  await browser.close();
}
