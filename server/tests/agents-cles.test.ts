// Carnet · lot 3, étape B : clés d'accès (WebAuthn) pour prouver le geste humain d'une décision.
// Authentificateur LOGICIEL de test (ES256 et Ed25519) : il fabrique attestationObject et assertions comme un appareil.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { coseVersJwk, lireCbor } from "../src/cles.ts";
import { demarrerBanc, HOTE, q } from "./aide.ts";
import type { Banc } from "./aide.ts";

// --- CBOR (encodeur minimal pour le test) ---
function tete(maj: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(maj << 5) | n]);
  if (n < 256) return Buffer.from([(maj << 5) | 24, n]);
  if (n < 65536) { const b = Buffer.alloc(3); b[0] = (maj << 5) | 25; b.writeUInt16BE(n, 1); return b; }
  const b = Buffer.alloc(5); b[0] = (maj << 5) | 26; b.writeUInt32BE(n, 1); return b;
}
function cbor(v: unknown): Buffer {
  if (typeof v === "number") return v >= 0 ? tete(0, v) : tete(1, -1 - v);
  if (typeof v === "string") { const b = Buffer.from(v, "utf8"); return Buffer.concat([tete(3, b.length), b]); }
  if (Buffer.isBuffer(v)) return Buffer.concat([tete(2, v.length), v]);
  if (v instanceof Map) return Buffer.concat([tete(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error("type");
}

const sha = (b: Buffer | string) => crypto.createHash("sha256").update(b).digest();
const b64u = (b: Buffer) => b.toString("base64url");

class Appareil {
  cles = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  id = crypto.randomBytes(32);
  compteur = 0;
  rpId: string;
  origine: string;
  ed: boolean;
  constructor(rpId = HOTE, origine = `http://${HOTE}`, ed = false) {
    this.rpId = rpId;
    this.origine = origine;
    this.ed = ed;
    if (ed) this.cles = crypto.generateKeyPairSync("ed25519") as unknown as typeof this.cles;
  }
  cose(): Map<number, unknown> {
    const jwk = this.cles.publicKey.export({ format: "jwk" });
    if (this.ed) return new Map<number, unknown>([[1, 1], [3, -8], [-1, 6], [-2, Buffer.from(jwk.x!, "base64url")]]);
    return new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, "base64url")], [-3, Buffer.from(jwk.y!, "base64url")]]);
  }
  creer(challenge: string, o: { uv?: boolean; origine?: string; rpId?: string } = {}) {
    const flags = 0x01 | (o.uv === false ? 0 : 0x04) | 0x40;
    const n = Buffer.alloc(2); n.writeUInt16BE(this.id.length);
    const authData = Buffer.concat([sha(o.rpId ?? this.rpId), Buffer.from([flags]), Buffer.alloc(4), Buffer.alloc(16), n, this.id, cbor(this.cose())]);
    const ao = cbor(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
    const cd = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge, origin: o.origine ?? this.origine, crossOrigin: false }));
    return { id: b64u(this.id), reponse: { clientDataJSON: b64u(cd), attestationObject: b64u(ao), transports: ["internal"] } };
  }
  signer(challenge: string, o: { uv?: boolean; origine?: string; compteur?: number } = {}) {
    this.compteur = o.compteur ?? this.compteur + 1;
    const c = Buffer.alloc(4); c.writeUInt32BE(this.compteur);
    const authData = Buffer.concat([sha(this.rpId), Buffer.from([0x01 | (o.uv === false ? 0 : 0x04)]), c]);
    const cd = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin: o.origine ?? this.origine, crossOrigin: false }));
    const donnees = Buffer.concat([authData, sha(cd)]);
    const sig = this.ed ? crypto.sign(null, donnees, this.cles.privateKey) : crypto.sign("sha256", donnees, { key: this.cles.privateKey, dsaEncoding: "der" });
    return { id: b64u(this.id), clientDataJSON: b64u(cd), authenticatorData: b64u(authData), signature: b64u(sig) };
  }
}

const DEMANDE = (id: string) => `---\ntype: decision\nid: ${id}\nstatut: en attente\ndemandee_par: Sacha\n---\n\n# Achat\n\n## Proposition\n\n- Objet : acheter un écran\n- Montant : 300 €\n`;

let b: Banc;
const indexer = (rels: string[]) => b.app.espace.verrou.executer(async () => b.app.espace.appliquer(await b.app.espace.traiter(rels)));
async function demande(rel: string, id: string): Promise<{ empreinte: string; id: string }> {
  fs.mkdirSync(path.join(b.espace, path.dirname(rel)), { recursive: true });
  fs.writeFileSync(path.join(b.espace, rel), DEMANDE(id));
  await indexer([rel.split("/")[0]]);
  return (await b.req("GET", "/api/decision?chemin=" + q(rel))).json;
}
const decider = (corps: Record<string, unknown>, requete = crypto.randomUUID()) =>
  b.req("POST", "/api/decision", { corps, entetes: { "X-Carnet-Requete": requete } });

before(async () => { b = await demarrerBanc(); });
after(async () => { await b.fermer(); });

describe("CBOR et COSE", () => {
  test("lecture des clés ES256 et Ed25519 ; refus des structures tronquées ou indéfinies", () => {
    const a = new Appareil();
    const lu = lireCbor(cbor(a.cose()));
    assert.equal(coseVersJwk(lu.valeur).alg, -7);
    assert.equal(coseVersJwk(lireCbor(cbor(new Appareil(HOTE, "", true).cose())).valeur).alg, -8);
    assert.throws(() => lireCbor(Buffer.from([0x5f])));
    assert.throws(() => lireCbor(Buffer.from([0x58, 10, 1, 2])));
    assert.throws(() => coseVersJwk(new Map([[1, 2], [3, -36]])));
  });
});

describe("sans clé enregistrée", () => {
  test("la décision reste possible, marquée « identité seule » (geste non prouvé)", async () => {
    const v = await demande("Achats/Un.md", "dec-cle-1");
    const r = await decider({ chemin: "Achats/Un.md", resultat: "approuvée", empreinte: v.empreinte, demande: v.id });
    assert.equal(r.statut, 200);
    assert.equal(r.json.geste, "identite-seule");
    const p = (await b.req("GET", "/api/page?chemin=" + q("Achats/Un.md"))).json.preuveDecision;
    assert.equal(p.geste, "identite-seule");
    assert.match(fs.readFileSync(path.join(b.espace, "Achats/Un.md"), "utf8"), /- Geste : identité du réseau seulement, geste non prouvé/);
  });
});

describe("enregistrement d'une clé (code d'enrôlement à usage unique créé hors de l'appli)", () => {
  const appareil = new Appareil();
  test("sans code, ou code faux : refus ; aucune route ne crée de code", async () => {
    assert.equal((await b.req("POST", "/api/cles/defi", { corps: { code: "AAAAA-BBBBB" } })).statut, 403);
    assert.equal((await b.req("POST", "/api/cles/code", { corps: {} })).statut, 404);
    const { code } = await b.app.api.agents.cles.creerCode();
    assert.match(code, /^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    assert.equal((await b.req("POST", "/api/cles/defi", { corps: { code: "ZZZZZ-ZZZZZ" } })).json.erreur, "Code d'enrôlement incorrect.");
    const st = fs.statSync(path.join(b.etat, "cles", "espace", "enrolement.json"));
    assert.equal(st.mode & 0o777, 0o600);
    assert.doesNotMatch(fs.readFileSync(path.join(b.etat, "cles", "espace", "enrolement.json"), "utf8"), new RegExp(code.replace("-", "")));
  });
  test("cinq essais faux annulent le code", async () => {
    await b.app.api.agents.cles.creerCode();
    for (let i = 0; i < 4; i++) await b.req("POST", "/api/cles/defi", { corps: { code: "ZZZZZ-ZZZZ" + i } });
    const r = await b.req("POST", "/api/cles/defi", { corps: { code: "ZZZZZ-ZZZZY" } });
    assert.match(r.json.erreur, /Trop d'essais/);
    assert.equal(fs.existsSync(path.join(b.etat, "cles", "espace", "enrolement.json")), false);
  });
  test("origine, RP ID ou vérification de l'utilisateur incorrects : refus", async () => {
    const { code } = await b.app.api.agents.cles.creerCode();
    const o = (await b.req("POST", "/api/cles/defi", { corps: { code } })).json;
    assert.equal(o.rp.id, HOTE);
    assert.equal(o.authenticatorSelection.userVerification, "required");
    assert.equal((await b.req("POST", "/api/cles", { corps: { code, ...appareil.creer(o.challenge, { origine: "http://evil.test" }) } })).statut, 403);
    assert.equal((await b.req("POST", "/api/cles", { corps: { code, ...appareil.creer(o.challenge, { rpId: "evil.test" }) } })).statut, 403);
    assert.equal((await b.req("POST", "/api/cles", { corps: { code, ...appareil.creer(o.challenge, { uv: false }) } })).statut, 403);
    assert.equal((await b.req("POST", "/api/cles", { corps: { code, ...appareil.creer("defi-inconnu") } })).statut, 403);
  });
  test("enregistrement valide ; le code ne resservira pas", async () => {
    const { code } = await b.app.api.agents.cles.creerCode();
    const o = (await b.req("POST", "/api/cles/defi", { corps: { code } })).json;
    const r = await b.req("POST", "/api/cles", { corps: { code, nom: "iPhone de test", ...appareil.creer(o.challenge) } });
    assert.equal(r.statut, 201, JSON.stringify(r.json));
    assert.equal(r.json.nom, "iPhone de test");
    const liste = (await b.req("GET", "/api/cles")).json;
    assert.equal(liste.cles.length, 1);
    assert.equal(liste.cles[0].ici, true);
    assert.equal(liste.enrolement, false);
    assert.equal((await b.req("POST", "/api/cles/defi", { corps: { code } })).statut, 403, "code à usage unique");
    const st = fs.statSync(path.join(b.etat, "cles", "espace", "cles.json"));
    assert.equal(st.mode & 0o777, 0o600);
  });

  describe("décisions avec clé enregistrée", () => {
    test("sans assertion : refus (un agent ne fabrique plus de décision, même « non prouvée »)", async () => {
      const v = await demande("Achats/Deux.md", "dec-cle-2");
      const r = await decider({ chemin: "Achats/Deux.md", resultat: "approuvée", empreinte: v.empreinte, demande: v.id });
      assert.equal(r.statut, 403);
      assert.equal(fs.readFileSync(path.join(b.espace, "Achats/Deux.md"), "utf8"), DEMANDE("dec-cle-2"));
    });
    test("assertion valide : geste « clé d'accès » prouvé ; le défi contient l'empreinte canonique de la décision", async () => {
      const v = await demande("Achats/Trois.md", "dec-cle-3");
      const corps = { chemin: "Achats/Trois.md", resultat: "approuvée", empreinte: v.empreinte, demande: v.id };
      const d = (await b.req("POST", "/api/decision/defi", { corps })).json;
      assert.equal(d.rpId, HOTE);
      assert.equal(d.userVerification, "required");
      assert.match(d.decisionId, /^dcs-\d{8}-\d{4}-[0-9a-z]{4}$/);
      assert.deepEqual({ ...d.decision, nonce: undefined }, {
        v: 1, espace: "espace", demande: v.id, empreinte: v.empreinte, resultat: "approuvée", portee: `proposition-figee-v1 decision=${d.decisionId} commentaire=aucun`, nonce: undefined,
      });
      const attendu = crypto.createHash("sha256").update(JSON.stringify(Object.fromEntries(Object.entries(d.decision).sort(([x], [y]) => x.localeCompare(y))))).digest("base64url");
      assert.equal(d.challenge, attendu);
      const req = crypto.randomUUID();
      const r = await decider({ ...corps, assertion: appareil.signer(d.challenge) }, req);
      assert.equal(r.statut, 200, JSON.stringify(r.json));
      assert.equal(r.json.geste, "cle-d-acces");
      assert.equal(r.json.decision, d.decisionId, "la décision écrite est celle du défi signé");
      const p = (await b.req("GET", "/api/page?chemin=" + q("Achats/Trois.md"))).json.preuveDecision;
      assert.equal(p.etat, "valide");
      assert.equal(p.geste, "cle-d-acces");
      assert.match(fs.readFileSync(path.join(b.espace, "Achats/Trois.md"), "utf8"), new RegExp(`Identifiant de décision : ${d.decisionId}`));
      // même requête rejouée : même réponse ; autre requête avec la même assertion : refus
      assert.equal((await decider({ ...corps, assertion: appareil.signer(d.challenge, { compteur: appareil.compteur }) }, req)).json.rejoue, true);
    });
    test("assertion pour une autre décision, rejouée, mauvaise origine, sans UV ou compteur qui recule : refus", async () => {
      const v = await demande("Achats/Quatre.md", "dec-cle-4");
      const corps = { chemin: "Achats/Quatre.md", resultat: "approuvée", empreinte: v.empreinte, demande: v.id };
      const d = (await b.req("POST", "/api/decision/defi", { corps })).json;
      assert.equal((await decider({ ...corps, resultat: "refusée", assertion: appareil.signer(d.challenge) })).statut, 403, "autre résultat");
      assert.equal((await decider({ ...corps, assertion: appareil.signer(d.challenge, { origine: "http://evil.test" }) })).statut, 403);
      assert.equal((await decider({ ...corps, assertion: appareil.signer(d.challenge, { uv: false }) })).statut, 403);
      const autre = new Appareil();
      assert.equal((await decider({ ...corps, assertion: autre.signer(d.challenge) })).statut, 403, "clé inconnue");
      const faux = appareil.signer(d.challenge);
      faux.signature = b64u(Buffer.from(faux.signature, "base64url").map((x, i) => (i === 10 ? x ^ 1 : x)));
      assert.equal((await decider({ ...corps, assertion: faux })).statut, 403, "signature altérée");
      assert.equal((await decider({ ...corps, assertion: appareil.signer(d.challenge, { compteur: 1 }) })).statut, 403, "compteur qui recule");
      assert.equal((await decider({ ...corps, commentaire: "ajouté après la confirmation", assertion: appareil.signer(d.challenge) })).statut, 403, "commentaire changé");
      const ok = await decider({ ...corps, assertion: appareil.signer(d.challenge) });
      assert.equal(ok.statut, 200, JSON.stringify(ok.json));
      const v5 = await demande("Achats/Cinq.md", "dec-cle-5");
      assert.equal((await decider({ chemin: "Achats/Cinq.md", resultat: "approuvée", empreinte: v5.empreinte, demande: v5.id, assertion: appareil.signer(d.challenge) })).statut, 403, "défi d'une autre décision");
      assert.equal(fs.readFileSync(path.join(b.espace, "Achats/Cinq.md"), "utf8"), DEMANDE("dec-cle-5"));
    });
    test("Ed25519 accepté", async () => {
      const ed = new Appareil(HOTE, `http://${HOTE}`, true);
      const { code } = await b.app.api.agents.cles.creerCode();
      const o = (await b.req("POST", "/api/cles/defi", { corps: { code } })).json;
      assert.equal((await b.req("POST", "/api/cles", { corps: { code, ...ed.creer(o.challenge) } })).statut, 201);
      const v = await demande("Achats/Six.md", "dec-cle-6");
      const corps = { chemin: "Achats/Six.md", resultat: "refusée", empreinte: v.empreinte, demande: v.id };
      const d = (await b.req("POST", "/api/decision/defi", { corps })).json;
      assert.equal((await decider({ ...corps, assertion: ed.signer(d.challenge) })).statut, 200);
    });
  });
});
