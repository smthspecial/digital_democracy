export async function api<T>(
  path: string,
  token?: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(
    path.startsWith("/auth/") ? path : `/api${path}`,
    {
      method: body === undefined ? "GET" : "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
  const value = await response.json();
  if (!response.ok) {
    const message =
      value.error?.message ??
      value.message ??
      `Request failed (${response.status})`;
    throw new Error(Array.isArray(message) ? message.join("; ") : message);
  }
  return value as T;
}

type Ceremony = {
  ceremony_token: string;
  options: {
    publicKey: PublicKeyCredentialCreationOptionsJSON &
      PublicKeyCredentialRequestOptionsJSON;
  };
};

export async function enroll(grant: string): Promise<void> {
  if (!window.isSecureContext || !window.PublicKeyCredential)
    throw new Error(
      "Passkeys need HTTPS or localhost and a supported browser.",
    );
  const ceremony = await api<Ceremony>(
    "/auth/passkeys/registration/begin",
    grant,
    {},
  );
  const credential = await navigator.credentials.create({
    publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(
      ceremony.options.publicKey,
    ),
  });
  if (!(credential instanceof PublicKeyCredential))
    throw new Error("Passkey registration was cancelled.");
  await api(
    "/auth/passkeys/registration/finish",
    ceremony.ceremony_token,
    credential.toJSON(),
  );
}

export type Session = {
  access_token: string;
  assurance_tier: string;
  access_expires_at: string;
};

export async function login(citizenId: string): Promise<Session> {
  if (!window.isSecureContext || !window.PublicKeyCredential)
    throw new Error(
      "Passkeys need HTTPS or localhost and a supported browser.",
    );
  const ceremony = await api<Ceremony>(
    "/auth/passkeys/login/begin",
    undefined,
    { citizen_id: citizenId },
  );
  const credential = await navigator.credentials.get({
    publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(
      ceremony.options.publicKey,
    ),
  });
  if (!(credential instanceof PublicKeyCredential))
    throw new Error("Passkey login was cancelled.");
  return api<Session>(
    "/auth/passkeys/login/finish",
    ceremony.ceremony_token,
    credential.toJSON(),
  );
}
