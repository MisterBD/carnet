// Tests du pont avec l'app iOS (web/src/natif.ts), sans navigateur : faux window.webkit, faux fetch, et un faux
// serveur qui dédoublonne par X-Carnet-Requete comme le socle (Ecrivain : même identifiant + même opération = rejeu).
//   cd carnet/web && node --test tests/natif.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classerStatut, corpsCapture, envoyerCaptureServeur, estAppIos, installerPontNatif, lireCapture, traiterLot,
  type CaptureNative, type MessageNatif, type ResultatEnvoi,
} from "../src/natif.ts";

const UA_APP = "Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 CarnetiOS/0.1.0";
const UA_SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1";
const A = "3f2a9c1e-5b7d-4e0f-9a61-2c8d4b7e1f05";
const B = "9b1d7c2a-0e4f-4a8b-8c6d-5e3f2a1b0c9d";
const C = "0c9d8e7f-6a5b-4c3d-9e2f-1a0b9c8d7e6f";
const D = "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a";

const cap = (id: string, texte: string, extra: Partial<CaptureNative> = {}): CaptureNative =>
  ({ id, cree: "2026-10-11T08:15:02+02:00", texte, ...extra });

/** Faux serveur : POST /api/capture, idempotent par (identité, X-Carnet-Requete). */
function fauxServeur() {
  const pages = new Map<string, { texte: string; lien?: string; titre?: string }>();
  const requetes: { entetes: Record<string, string>; corps: unknown }[] = [];
  let enPanne = false;
  const f = (async (url: string, init: RequestInit) => {
    if (enPanne) throw new TypeError("Load failed");
    const entetes = init.headers as Record<string, string>;
    const corps = JSON.parse(String(init.body));
    requetes.push({ entetes, corps });
    if (url !== "/api/capture" || init.method !== "POST" || entetes["X-Carnet"] !== "1") return new Response("{}", { status: 403 });
    const cle = entetes["X-Carnet-Requete"];
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(cle)) return new Response("{}", { status: 400 });
    if (!corps.texte.trim() && !corps.lien) return new Response("{}", { status: 400 });
    if (pages.has(cle)) return new Response("{}", { status: 200 });
    pages.set(cle, corps);
    return new Response("{}", { status: 201 });
  }) as unknown as typeof fetch;
  return { f, pages, requetes, panne: (v: boolean) => { enPanne = v; } };
}

test("détection de l'app iOS par le User-Agent", () => {
  assert.equal(estAppIos(UA_APP), true);
  assert.equal(estAppIos(UA_SAFARI), false);
  assert.equal(estAppIos("CarnetiOS/"), false);
  assert.equal(estAppIos("xCarnetiOS/1.0"), false);
});

test("capture du natif vérifiée avant tout envoi", () => {
  assert.deepEqual(lireCapture(cap(A, "Note", { lien: "https://exemple.org", titre: "T" })),
    { id: A, cree: "2026-10-11T08:15:02+02:00", texte: "Note", lien: "https://exemple.org", titre: "T" });
  assert.equal(lireCapture(cap(A.toUpperCase(), "x")), null);
  assert.equal(lireCapture(cap("../etc/passwd", "x")), null);
  assert.equal(lireCapture({ id: A, texte: 3, cree: "x" }), null);
  assert.equal(lireCapture(cap(A, "  ")), null);
  assert.equal(lireCapture(null), null);
});

test("corps de POST /api/capture : un lien non web passe dans le texte", () => {
  assert.deepEqual(corpsCapture(cap(A, "Écrire", { lien: "mailto:camille@exemple.test" })), { texte: "Écrire\n\nmailto:camille@exemple.test" });
  assert.deepEqual(corpsCapture(cap(A, "", { lien: "https://exemple.org/a", titre: "Article" })),
    { texte: "", lien: "https://exemple.org/a", titre: "Article" });
});

test("classement des réponses du serveur", () => {
  const attendu: [number, ResultatEnvoi][] = [[201, "enregistre"], [200, "enregistre"], [400, "refuse"], [409, "refuse"],
    [413, "refuse"], [403, "reessayer"], [404, "reessayer"], [429, "reessayer"], [502, "reessayer"]];
  for (const [s, r] of attendu) assert.equal(classerStatut(s), r, String(s));
});

test("envoi : même origine, X-Carnet et identifiant d'idempotence = identifiant de la capture", async () => {
  const s = fauxServeur();
  assert.equal(await envoyerCaptureServeur(cap(A, "Note"), s.f), "enregistre");
  assert.equal(s.requetes[0].entetes["X-Carnet"], "1");
  assert.equal(s.requetes[0].entetes["X-Carnet-Requete"], A);
  assert.deepEqual(s.requetes[0].corps, { texte: "Note" });
  s.panne(true);
  assert.equal(await envoyerCaptureServeur(cap(B, "x"), s.f), "reessayer");
});

test("lot : acquittement par capture, arrêt au premier échec passager, fin de lot", async () => {
  const messages: MessageNatif[] = [];
  const reponses: ResultatEnvoi[] = ["refuse", "reessayer"];
  const envoyees: string[] = [];
  const bilan = await traiterLot({ lot: 4, captures: [cap(A, "a"), cap(B, ""), { id: "abimee" }, cap(C, "c"), cap(D, "d")] }, {
    envoyer: async (c) => { envoyees.push(c.id); return reponses.shift() ?? "enregistre"; },
    poster: (m) => messages.push(m),
  });
  // B (texte vide sans lien) et la capture abîmée ne partent pas ; après l'échec passager de C, D n'est pas tentée
  assert.deepEqual(envoyees, [A, C]);
  assert.deepEqual(messages, [
    { type: "acquitte", id: A, resultat: "refuse" },
    { type: "etat", pret: true, lot: 4 },
  ]);
  assert.deepEqual(bilan, { enregistrees: 0, refusees: 1, enEchec: 4 });
  // charge sans numéro de lot valide : rien n'est annoncé comme fin de lot
  const autres: MessageNatif[] = [];
  await traiterLot({ lot: "2", captures: "x" }, { envoyer: async () => "enregistre", poster: (m) => autres.push(m) });
  assert.deepEqual(autres, []);
});

test("pont : inactif hors de l'app", () => {
  const w: Record<string, unknown> = { navigator: { userAgent: UA_SAFARI }, webkit: { messageHandlers: { carnet: { postMessage() {} } } } };
  assert.equal(installerPontNatif(w), false);
  assert.equal(w.carnetNatif, undefined);
  const sansNatif: Record<string, unknown> = { navigator: { userAgent: UA_APP } };
  assert.equal(installerPontNatif(sansNatif), false);
  assert.equal(sansNatif.carnetNatif, undefined);
});

test("pont de bout en bout : plusieurs vidages, aucun doublon, acquittements, objet non remplaçable", async () => {
  const s = fauxServeur();
  const messages: MessageNatif[] = [];
  const evenements: unknown[] = [];
  const w: Record<string, unknown> = {
    navigator: { userAgent: UA_APP },
    fetch: s.f,
    webkit: { messageHandlers: { carnet: { postMessage: (m: MessageNatif) => messages.push(structuredClone(m)) } } },
    dispatchEvent: (e: CustomEvent) => { evenements.push(e.detail); return true; },
  };
  assert.equal(installerPontNatif(w), true);
  assert.deepEqual(messages, [{ type: "etat", pret: true }]);
  const natif = w.carnetNatif as { recevoirCaptures: (c: unknown) => Promise<void> };
  assert.throws(() => { (w as { carnetNatif: unknown }).carnetNatif = {}; });
  assert.equal(installerPontNatif(w), true);               // deuxième installation : rien de plus
  assert.equal(messages.length, 1);

  // 1er vidage : serveur injoignable → rien d'acquitté, fin de lot quand même
  s.panne(true);
  await natif.recevoirCaptures({ lot: 1, captures: [cap(A, "a"), cap(B, "b")] });
  assert.deepEqual(messages.slice(1), [{ type: "etat", pret: true, lot: 1 }]);
  // 2e vidage : A passe, mais imaginons que l'acquittement se perde côté natif → le natif renvoie A au 3e
  s.panne(false);
  await natif.recevoirCaptures({ lot: 2, captures: [cap(A, "a"), cap(B, "b")] });
  await natif.recevoirCaptures({ lot: 3, captures: [cap(A, "a")] });
  assert.equal(s.pages.size, 2);                           // A et B, une seule page chacune
  assert.equal(s.requetes.length, 3);
  assert.deepEqual(messages.slice(2), [
    { type: "acquitte", id: A, resultat: "enregistre" },
    { type: "acquitte", id: B, resultat: "enregistre" },
    { type: "etat", pret: true, lot: 2 },
    { type: "acquitte", id: A, resultat: "enregistre" },   // rejeu (200) : acquitté, pas recréé
    { type: "etat", pret: true, lot: 3 },
  ]);
  assert.deepEqual(evenements, [{ enregistrees: 2, refusees: 0, enEchec: 0 }, { enregistrees: 1, refusees: 0, enEchec: 0 }]);
});

test("pont : deux lots confiés coup sur coup sont traités l'un après l'autre", async () => {
  const ordre: string[] = [];
  const s = fauxServeur();
  const lent = (async (url: string, init: RequestInit) => {
    const id = (init.headers as Record<string, string>)["X-Carnet-Requete"];
    ordre.push(`debut ${id}`);
    await new Promise((r) => setTimeout(r, id === A ? 20 : 1));
    ordre.push(`fin ${id}`);
    return s.f(url, init);
  }) as unknown as typeof fetch;
  const w: Record<string, unknown> = {
    navigator: { userAgent: UA_APP }, fetch: lent, webkit: { messageHandlers: { carnet: { postMessage() {} } } },
  };
  installerPontNatif(w);
  const natif = w.carnetNatif as { recevoirCaptures: (c: unknown) => Promise<void> };
  await Promise.all([natif.recevoirCaptures({ lot: 1, captures: [cap(A, "a")] }), natif.recevoirCaptures({ lot: 2, captures: [cap(B, "b")] })]);
  assert.deepEqual(ordre, [`debut ${A}`, `fin ${A}`, `debut ${B}`, `fin ${B}`]);
});
