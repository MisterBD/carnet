# Licences et mentions tierces

Carnet est publié sous [licence MIT](LICENSE), Copyright (c) 2026 Dimitri Foucault. Ce fichier liste ce qui vient d'ailleurs : dépendances, bibliothèques du kit d'artefacts, polices, icônes et code éventuellement repris d'autres projets. Un contrôle automatique à l'export refuse toute dépendance sous licence non autorisée (GPL, AGPL, LGPL, SSPL, propriétaire, paquets Tiptap payants, paquets BlockNote `xl-*`).

Le texte complet de chaque licence accompagne chaque paquet (`node_modules/<paquet>/LICENSE`) et, pour le kit d'artefacts, le dossier `kit/licences/` généré à la construction de l'image.

## 1. Dépendances npm

Table générée à partir de `web/package-lock.json` et `server/package-lock.json` (112 paquets livrés avec l'application).

<details>
<summary>Dépendances livrées avec l'application (112 paquets)</summary>

| Composant | Paquet | Version | Licence |
|---|---|---|---|
| serveur | `yaml` | 2.9.1 | ISC |
| interface | `@floating-ui/core` | 1.8.0 | MIT |
| interface | `@floating-ui/dom` | 1.8.0 | MIT |
| interface | `@floating-ui/utils` | 0.2.12 | MIT |
| interface | `@tiptap/core` | 3.31.4 | MIT |
| interface | `@tiptap/extension-blockquote` | 3.31.4 | MIT |
| interface | `@tiptap/extension-bold` | 3.31.4 | MIT |
| interface | `@tiptap/extension-code` | 3.31.4 | MIT |
| interface | `@tiptap/extension-code-block` | 3.31.4 | MIT |
| interface | `@tiptap/extension-code-block-lowlight` | 3.31.4 | MIT |
| interface | `@tiptap/extension-details` | 3.31.4 | MIT |
| interface | `@tiptap/extension-document` | 3.31.4 | MIT |
| interface | `@tiptap/extension-file-handler` | 3.31.4 | MIT |
| interface | `@tiptap/extension-hard-break` | 3.31.4 | MIT |
| interface | `@tiptap/extension-heading` | 3.31.4 | MIT |
| interface | `@tiptap/extension-highlight` | 3.31.4 | MIT |
| interface | `@tiptap/extension-horizontal-rule` | 3.31.4 | MIT |
| interface | `@tiptap/extension-italic` | 3.31.4 | MIT |
| interface | `@tiptap/extension-link` | 3.31.4 | MIT |
| interface | `@tiptap/extension-list` | 3.31.4 | MIT |
| interface | `@tiptap/extension-paragraph` | 3.31.4 | MIT |
| interface | `@tiptap/extension-strike` | 3.31.4 | MIT |
| interface | `@tiptap/extension-table` | 3.31.4 | MIT |
| interface | `@tiptap/extension-text` | 3.31.4 | MIT |
| interface | `@tiptap/extension-text-style` | 3.31.4 | MIT |
| interface | `@tiptap/extension-underline` | 3.31.4 | MIT |
| interface | `@tiptap/extensions` | 3.31.4 | MIT |
| interface | `@tiptap/pm` | 3.31.4 | MIT |
| interface | `@tiptap/suggestion` | 3.31.4 | MIT |
| interface | `@types/debug` | 4.1.13 | MIT |
| interface | `@types/hast` | 3.0.5 | MIT |
| interface | `@types/mdast` | 4.0.4 | MIT |
| interface | `@types/ms` | 2.1.0 | MIT |
| interface | `@types/unist` | 3.0.3 | MIT |
| interface | `ccount` | 2.0.1 | MIT |
| interface | `character-entities` | 2.0.2 | MIT |
| interface | `debug` | 4.4.3 | MIT |
| interface | `decode-named-character-reference` | 1.3.0 | MIT |
| interface | `dequal` | 2.0.3 | MIT |
| interface | `devlop` | 1.1.0 | MIT |
| interface | `escape-string-regexp` | 5.0.0 | MIT |
| interface | `highlight.js` | 11.11.2 | BSD-3-Clause |
| interface | `linkifyjs` | 4.3.3 | MIT |
| interface | `longest-streak` | 3.1.0 | MIT |
| interface | `lowlight` | 3.3.0 | MIT |
| interface | `lucide-react` | 1.53.0 | ISC |
| interface | `markdown-table` | 3.0.4 | MIT |
| interface | `mdast-util-find-and-replace` | 3.0.3 | MIT |
| interface | `mdast-util-from-markdown` | 2.1.0 | MIT |
| interface | `mdast-util-gfm` | 3.1.0 | MIT |
| interface | `mdast-util-gfm-autolink-literal` | 2.0.1 | MIT |
| interface | `mdast-util-gfm-footnote` | 2.1.0 | MIT |
| interface | `mdast-util-gfm-strikethrough` | 2.0.1 | MIT |
| interface | `mdast-util-gfm-table` | 2.0.0 | MIT |
| interface | `mdast-util-gfm-task-list-item` | 2.0.0 | MIT |
| interface | `mdast-util-phrasing` | 4.1.0 | MIT |
| interface | `mdast-util-to-markdown` | 2.2.0 | MIT |
| interface | `mdast-util-to-string` | 4.0.0 | MIT |
| interface | `micromark` | 4.0.3 | MIT |
| interface | `micromark-core-commonmark` | 2.0.4 | MIT |
| interface | `micromark-extension-gfm` | 3.0.0 | MIT |
| interface | `micromark-extension-gfm-autolink-literal` | 2.1.0 | MIT |
| interface | `micromark-extension-gfm-footnote` | 2.1.0 | MIT |
| interface | `micromark-extension-gfm-strikethrough` | 2.1.0 | MIT |
| interface | `micromark-extension-gfm-table` | 2.1.2 | MIT |
| interface | `micromark-extension-gfm-tagfilter` | 2.0.0 | MIT |
| interface | `micromark-extension-gfm-task-list-item` | 2.1.0 | MIT |
| interface | `micromark-factory-destination` | 2.0.1 | MIT |
| interface | `micromark-factory-label` | 2.0.1 | MIT |
| interface | `micromark-factory-space` | 2.1.0 | MIT |
| interface | `micromark-factory-title` | 2.0.1 | MIT |
| interface | `micromark-factory-whitespace` | 2.0.1 | MIT |
| interface | `micromark-util-character` | 2.1.1 | MIT |
| interface | `micromark-util-chunked` | 2.0.1 | MIT |
| interface | `micromark-util-classify-character` | 2.0.1 | MIT |
| interface | `micromark-util-combine-extensions` | 2.0.1 | MIT |
| interface | `micromark-util-decode-numeric-character-reference` | 2.0.2 | MIT |
| interface | `micromark-util-decode-string` | 2.0.1 | MIT |
| interface | `micromark-util-edit-map` | 1.0.0 | MIT |
| interface | `micromark-util-encode` | 2.0.1 | MIT |
| interface | `micromark-util-html-tag-name` | 2.0.1 | MIT |
| interface | `micromark-util-normalize-identifier` | 2.0.1 | MIT |
| interface | `micromark-util-resolve-all` | 2.0.1 | MIT |
| interface | `micromark-util-sanitize-uri` | 2.0.1 | MIT |
| interface | `micromark-util-subtokenize` | 2.1.0 | MIT |
| interface | `micromark-util-symbol` | 2.0.1 | MIT |
| interface | `micromark-util-types` | 2.0.3 | MIT |
| interface | `ms` | 2.1.3 | MIT |
| interface | `orderedmap` | 2.1.1 | MIT |
| interface | `prosemirror-changeset` | 2.4.4 | MIT |
| interface | `prosemirror-commands` | 1.7.2 | MIT |
| interface | `prosemirror-dropcursor` | 1.8.4 | MIT |
| interface | `prosemirror-gapcursor` | 1.4.1 | MIT |
| interface | `prosemirror-history` | 1.5.1 | MIT |
| interface | `prosemirror-inputrules` | 1.5.1 | MIT |
| interface | `prosemirror-keymap` | 1.2.3 | MIT |
| interface | `prosemirror-model` | 1.25.12 | MIT |
| interface | `prosemirror-schema-list` | 1.5.1 | MIT |
| interface | `prosemirror-state` | 1.4.4 | MIT |
| interface | `prosemirror-tables` | 1.8.5 | MIT |
| interface | `prosemirror-transform` | 1.12.2 | MIT |
| interface | `prosemirror-view` | 1.42.6 | MIT |
| interface | `react` | 19.3.0 | MIT |
| interface | `react-dom` | 19.3.0 | MIT |
| interface | `rope-sequence` | 1.3.4 | MIT |
| interface | `scheduler` | 0.28.0 | MIT |
| interface | `unist-util-is` | 6.0.1 | MIT |
| interface | `unist-util-stringify-position` | 4.0.0 | MIT |
| interface | `unist-util-visit` | 5.1.0 | MIT |
| interface | `unist-util-visit-parents` | 6.0.2 | MIT |
| interface | `w3c-keyname` | 2.2.8 | MIT |
| interface | `zwitch` | 2.0.4 | MIT |

</details>

Outils de construction et de test, **non livrés** : 65 paquets sous licences MIT (29), Apache-2.0 (22), MPL-2.0 (12), ISC (1), BSD-3-Clause (1).
Parmi eux, `lightningcss` (MPL-2.0, copyleft par fichier) n'est utilisé que pour construire ; le code est inchangé et n'est pas redistribué.

## 2. Kit d'artefacts (téléchargé à la construction de l'image)

Le serveur d'artefacts sert des bibliothèques épinglées par version et empreinte sha512 (`artefacts/kit.lock.json`), téléchargées sur le registre npm par `artefacts/maj-kit.py`. Aucune n'est copiée dans ce dépôt. Aucune n'est chargée depuis un CDN à l'exécution.

| Bibliothèque | Version | Licence | Copyright |
|---|---|---|---|
| Chart.js | 4.5.1 | MIT | © 2014-2024 Chart.js Contributors |
| Apache ECharts | 6.1.0 | Apache-2.0 (fichier NOTICE joint) | © 2017-2026 The Apache Software Foundation |
| Mermaid | 12.1.0 | MIT | © 2014-2022 Knut Sveidqvist |
| Vega | 6.4.0 | BSD-3-Clause | © 2015-2023 University of Washington Interactive Data Lab |
| Vega-Lite | 6.4.3 | BSD-3-Clause | © 2015 University of Washington Interactive Data Lab |
| vega-embed | 7.3.0 | BSD-3-Clause | © 2015 University of Washington Interactive Data Lab |
| vega-interpreter | 2.3.2 | BSD-3-Clause | © 2015-2023 University of Washington Interactive Data Lab |
| Lucide (UMD) | 1.52.0 | ISC, avec une partie MIT (voir §4) | © 2026 Lucide Icons and Contributors |
| Roboto (@fontsource) | 5.3.0 | OFL-1.1 | © 2011 The Roboto Project Authors |
| Crimson Pro (@fontsource) | 5.3.0 | OFL-1.1 | © 2018 The Crimson Pro Project Authors |

`artefacts/kit-local/pont.js` est le pont `postMessage` du projet, sous la licence du dépôt (MIT).

## 3. Polices

Les polices ci-dessous sont distribuées sous la **SIL Open Font License 1.1**. Elles sont servies localement, jamais depuis un service tiers. La licence peut être copiée, utilisée, étudiée, modifiée et redistribuée librement, à condition de ne pas vendre les polices seules et de conserver la mention de copyright et le texte de la licence. Les textes complets sont dans [`licences/`](licences/).

| Police | Usage | Copyright | Fichier de licence |
|---|---|---|---|
| Literata (variable, axe optique) | titres de l'application | © 2017 The Literata Project Authors (https://github.com/googlefonts/literata) | [`licences/OFL-Literata.txt`](licences/OFL-Literata.txt), `web/public/polices/LICENCE-Literata.txt` |
| Atkinson Hyperlegible Next (romain et italique) | texte de l'application | © 2020-2024 The Atkinson Hyperlegible Next Project Authors (https://github.com/googlefonts/atkinson-hyperlegible-next) | [`licences/OFL-Atkinson-Hyperlegible-Next.txt`](licences/OFL-Atkinson-Hyperlegible-Next.txt), `web/public/polices/LICENCE-Atkinson-Hyperlegible-Next.txt` |
| Roboto 400, 500, 700 (sous-ensemble latin) | kit des artefacts | © 2011 The Roboto Project Authors (https://github.com/googlefonts/roboto-classic) | [`licences/OFL-Roboto.txt`](licences/OFL-Roboto.txt) |
| Crimson Pro 400, 600 (sous-ensemble latin) | kit des artefacts | © 2018 The Crimson Pro Project Authors (https://github.com/Fonthausen/CrimsonPro) | [`licences/OFL-Crimson-Pro.txt`](licences/OFL-Crimson-Pro.txt) |

## 4. Icônes

- **Lucide** (`lucide-react` et `lucide`), licence ISC, © 2026 Lucide Icons and Contributors. Certaines icônes de Lucide dérivent de **Feather**, licence MIT, © 2013-present Cole Bemis. Les deux licences s'appliquent aux icônes concernées. Le texte complet figure dans `node_modules/lucide-react/LICENSE`.
- Les icônes de l'application (`web/public/icones/`) sont un dessin original du projet, sous la licence du dépôt (MIT).

## 5. Code et ressources repris d'autres projets

**Aucun fichier ni extrait de code d'un autre projet n'est repris dans ce dépôt.** Vérifié le 8 octobre 2026 sur tout le code publié (`server/`, `shared/`, `web/`, `artefacts/`) : aucun en-tête de licence ou de copyright tiers, aucun fichier copié ; le menu `/` et ses alias de recherche, la liste d'emojis et ses mots-clés, la feuille d'impression, l'historique des versions et le calcul des différences (algorithme de Myers, réécrit) sont écrits pour Carnet. Les seules choses qui viennent d'ailleurs sont les dépendances (§1), le kit d'artefacts (§2), les polices (§3) et les icônes (§4).

Carnet a été conçu après l'étude de projets existants, pour leurs comportements et leur vocabulaire, pas pour leur code :

| Projet étudié | Licence | Ce qui a nourri Carnet (idées, rien de recopié) |
|---|---|---|
| Docs (La Suite numérique, `suitenumerique/docs`) | MIT | corbeille, historique des versions, impression, états vides et d'erreur |
| BlockNote (`TypeCellOS/BlockNote`), paquets hors `xl-*` | MPL-2.0 | menu `/` en français avec alias, barre d'outils au-dessus du clavier |
| AFFiNE / BlockSuite (`toeverything/AFFiNE`), hors `packages/backend` et parties « EE » | MIT | micro-comportements de l'éditeur (repère de glisser-déposer), vocabulaire français de l'interface |
| Novel (`steven-tey/novel`) | Apache-2.0 | ergonomie d'un éditeur Tiptap |

Les projets sous licence **copyleft forte ou à usage restreint** (AGPL, GPL, BSL : AppFlowy, Outline, Docmost, partie « Enterprise » d'AFFiNE) ont été étudiés en **salle blanche** : leurs comportements ont été décrits par écrit avec nos propres mots, et le code de Carnet est écrit à partir de ces descriptions, pas de leurs sources. Aucun de leurs fichiers n'est repris. Exclus et jamais utilisés : tout paquet sous GPL-3.0, AGPL-3.0 ou licence commerciale (par exemple `@blocknote/xl-*`, `@y/hub`, les paquets Tiptap « Pro »).

Si du code d'un projet sous licence permissive (MIT, Apache-2.0, BSD) ou à copyleft par fichier (MPL-2.0) est repris un jour, le fichier gardera son en-tête d'origine, il aura sa ligne ici avec la mention de copyright à conserver, et ses modifications seront signalées.

## 6. Signaler une omission

Si tu repères une mention manquante, ouvre une issue : elle sera corrigée en priorité.
