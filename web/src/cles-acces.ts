// Clés d'accès (WebAuthn) côté interface : enregistrement d'une clé (avec le code d'enrôlement créé sur le serveur)
// et signature d'une décision (Face ID sur iPhone, Touch ID sur Mac). Aucune dépendance : l'API du navigateur suffit.
// Le serveur vérifie tout (défi lié à la décision, origine, RP ID, vérification de l'utilisateur, signature).

/** WebAuthn utilisable ici : navigateur compatible ET contexte sécurisé (https, ou localhost en développement). */
export function webauthnDisponible(): boolean {
  return typeof window !== "undefined" && window.isSecureContext && typeof window.PublicKeyCredential === "function" && !!navigator.credentials;
}

function versOctets(s: string): ArrayBuffer {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  const o = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) o[i] = b.charCodeAt(i);
  return o.buffer;
}

function versB64u(b: ArrayBuffer | ArrayBufferView): string {
  const o = b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  let s = "";
  for (const x of o) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

type Descr = { type: "public-key"; id: string; transports?: string[] };

function descripteurs(l: unknown): PublicKeyCredentialDescriptor[] {
  return (Array.isArray(l) ? (l as Descr[]) : []).map((c) => ({ type: "public-key", id: versOctets(c.id), ...(c.transports ? { transports: c.transports as AuthenticatorTransport[] } : {}) }));
}

/** navigator.credentials.create avec les options du serveur ; renvoie la réponse prête à envoyer (base64url). */
export async function creerCle(o: Record<string, unknown>): Promise<Record<string, unknown>> {
  const user = o.user as { id: string; name: string; displayName: string };
  const cle = (await navigator.credentials.create({
    publicKey: {
      challenge: versOctets(String(o.challenge)),
      rp: o.rp as PublicKeyCredentialRpEntity,
      user: { id: versOctets(user.id), name: user.name, displayName: user.displayName },
      pubKeyCredParams: o.pubKeyCredParams as PublicKeyCredentialParameters[],
      authenticatorSelection: o.authenticatorSelection as AuthenticatorSelectionCriteria,
      attestation: "none",
      timeout: Number(o.timeout) || 300_000,
      excludeCredentials: descripteurs(o.excludeCredentials),
    },
  })) as PublicKeyCredential | null;
  if (!cle) throw new Error("Aucune clé créée.");
  const r = cle.response as AuthenticatorAttestationResponse;
  return {
    id: versB64u(cle.rawId),
    reponse: {
      clientDataJSON: versB64u(r.clientDataJSON),
      attestationObject: versB64u(r.attestationObject),
      transports: typeof r.getTransports === "function" ? r.getTransports() : undefined,
    },
  };
}

/** navigator.credentials.get pour le défi d'une décision ; renvoie l'assertion (base64url). */
export async function signerDecision(o: Record<string, unknown>): Promise<Record<string, unknown>> {
  const a = (await navigator.credentials.get({
    publicKey: {
      challenge: versOctets(String(o.challenge)),
      rpId: String(o.rpId),
      allowCredentials: descripteurs(o.allowCredentials),
      userVerification: "required",
      timeout: Number(o.timeout) || 300_000,
    },
  })) as PublicKeyCredential | null;
  if (!a) throw new Error("Confirmation annulée.");
  const r = a.response as AuthenticatorAssertionResponse;
  return {
    id: versB64u(a.rawId),
    clientDataJSON: versB64u(r.clientDataJSON),
    authenticatorData: versB64u(r.authenticatorData),
    signature: versB64u(r.signature),
    userHandle: r.userHandle ? versB64u(r.userHandle) : null,
  };
}

/** Message lisible pour une erreur de navigator.credentials (annulation, délai, appareil incompatible). */
export function messageWebauthn(e: unknown): string {
  const n = (e as { name?: string })?.name;
  if (n === "NotAllowedError") return "Confirmation annulée ou délai dépassé.";
  if (n === "InvalidStateError") return "Cette clé est déjà enregistrée sur cet appareil.";
  if (n === "SecurityError") return "Adresse non sécurisée : les clés d'accès demandent https (ou localhost).";
  if (n === "NotSupportedError") return "Cet appareil ne propose pas de clé d'accès compatible.";
  return (e as Error)?.message || "La clé d'accès n'a pas répondu.";
}

/** Identifiant unique d'un geste (idempotence : le même identifiant est renvoyé en cas de nouvel essai). */
export function nouvelleRequete(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const o = crypto.getRandomValues(new Uint8Array(16));
  return versB64u(o);
}
