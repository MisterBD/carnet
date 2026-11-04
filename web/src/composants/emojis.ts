// Sélecteur d'emoji léger, sans réseau ni bibliothèque : ~330 emojis courants avec des mots-clés en français
// (recherche sans accents). Format compact : « emoji mots-clés » séparés par « | ».

export interface GroupeEmoji { nom: string; emojis: Array<{ e: string; mots: string }> }

const BRUT: Array<[string, string]> = [
  ["Fréquents",
    "📝 note memo ecrire|📌 epingle punaise important|⭐ etoile favori|✅ fait valide coche ok|📅 calendrier date agenda|💡 idee ampoule|🎯 cible objectif but|🚀 fusee lancement projet|📚 livres lecture bibliotheque|🗂️ classeur dossier archive|📁 dossier|🏠 maison accueil|💼 travail mallette mission client|🧭 boussole direction|🌊 vague mer ocean houle|🔥 feu urgent chaud"],
  ["Visages",
    "😀 sourire content|😃 joie|😄 rire|😁 grand sourire|😆 hilare|😅 sueur ouf|😂 larmes rire mdr|🙂 sourire leger|😉 clin oeil|😊 timide content|😇 ange|🥰 amour coeurs|😍 adore|🤩 etoiles waouh|😘 bisou|😋 miam|😎 cool lunettes|🤓 geek intello|🧐 monocle examiner|🤔 reflechir question|🤨 doute sourcil|😐 neutre|😑 blase|😶 muet|🙄 yeux au ciel|😏 malin|😬 gene grimace|😌 soulage|😔 pensif triste|😪 fatigue|😴 dormir sommeil|😷 masque malade|🤒 fievre|🤯 explosion cerveau|🥳 fete anniversaire|🥺 supplier|😢 pleurer triste|😭 sanglots|😤 enerve|😠 colere|😱 peur cri|😳 rougir surpris|🤗 calin|🤫 chut secret|🤐 bouche cousue|🙃 a l envers ironie|🫠 fondre|🤖 robot agent ia|👻 fantome|💀 crane|👽 extraterrestre"],
  ["Gestes et personnes",
    "👍 pouce ok bien|👎 pouce bas pas bien|👏 applaudir bravo|🙌 hourra|🙏 merci prier|🤝 accord poignee main partenariat|👋 salut coucou|✌️ victoire paix|🤞 croiser doigts chance|👌 parfait ok|👉 doigt droite|👈 doigt gauche|☝️ doigt haut|👇 doigt bas|💪 force muscle|✍️ ecrire main|🫶 coeur mains|👀 yeux regarder|🧠 cerveau reflexion|🗣️ parler podcast|👤 personne profil|👥 equipe groupe|👨‍💻 developpeur informatique|👩‍💻 developpeuse informatique|🧑‍🏫 formateur prof formation|🧑‍💼 consultant bureau|👨‍👩‍👧 famille|👶 bebe|🧒 enfant|🧘 meditation zen|🏃 courir sport|🚶 marcher"],
  ["Nature",
    "🌱 pousse debut croissance|🌿 feuille plante|🍀 trefle chance|🌳 arbre|🌲 sapin|🌴 palmier vacances|🌵 cactus|🌸 fleur cerisier sakura|🌻 tournesol|🌹 rose|🍁 erable automne|🍂 feuilles automne|🌍 terre monde europe|🌎 terre amerique|🌏 terre asie|🌙 lune nuit|☀️ soleil|⛅ nuage soleil|🌧️ pluie|⛈️ orage|❄️ neige flocon hiver|🌈 arc en ciel|⚡ eclair rapide energie|💧 goutte eau|🔆 lumiere|🌋 volcan|🏔️ montagne|🐶 chien|🐱 chat|🐭 souris|🦊 renard|🐻 ours|🐼 panda|🐨 koala|🦁 lion|🐯 tigre|🐮 vache|🐷 cochon|🐸 grenouille|🐵 singe|🐔 poule|🐧 pingouin|🐦 oiseau|🦉 hibou chouette|🦋 papillon|🐝 abeille|🐢 tortue lent|🐍 serpent python|🐙 poulpe|🐬 dauphin|🐳 baleine|🦈 requin|🐟 poisson"],
  ["Nourriture",
    "☕ cafe pause|🍵 the|🥐 croissant petit dejeuner|🥖 baguette pain|🧀 fromage|🍎 pomme|🍐 poire|🍊 orange|🍋 citron|🍌 banane|🍉 pasteque|🍇 raisin|🍓 fraise|🍒 cerise|🥑 avocat|🥕 carotte|🍅 tomate|🥗 salade|🍕 pizza|🍔 burger|🍟 frites|🌮 taco|🍣 sushi|🍜 ramen nouilles|🍝 pates|🍳 oeuf cuisine|🥘 plat mijote|🍰 gateau|🎂 anniversaire gateau|🍪 cookie biscuit|🍫 chocolat|🍿 popcorn film|🍷 vin|🍺 biere|🥂 champagne trinquer|🍾 bouteille fete|🛒 courses chariot|🍽️ repas restaurant"],
  ["Activités",
    "⚽ football|🏀 basket|🎾 tennis|🏐 volley|🏉 rugby|🏓 ping pong|🏸 badminton|⛳ golf|🎿 ski|🏄 surf|🚴 velo|🏊 natation piscine|🧗 escalade|🏋️ musculation|🎮 jeu video|🎲 de jeu|♟️ echecs strategie|🎯 flechettes|🎨 peinture art|🎭 theatre|🎬 film cinema video|🎤 micro chanter|🎧 casque musique podcast ecoute|🎙️ micro studio podcast enregistrement|🎵 musique note|🎸 guitare|🎹 piano|🥁 batterie|📷 photo appareil|🏆 trophee victoire|🥇 medaille premier|🎉 fete confettis|🎁 cadeau|🎈 ballon fete|🎓 diplome formation etudes"],
  ["Voyages et lieux",
    "✈️ avion voyage vol|🚆 train|🚇 metro|🚌 bus|🚗 voiture|🚕 taxi|🚲 velo|🛴 trottinette|⛵ voilier bateau|🚢 navire|🗺️ carte plan|🧳 valise voyage|🏖️ plage vacances|🏝️ ile|⛰️ montagne|🏕️ camping|🏙️ ville|🌆 ville soir|🏢 bureau immeuble entreprise|🏭 usine industrie|🏥 hopital sante|🏫 ecole|🏦 banque|🏪 magasin boutique|🏨 hotel|🏛️ institution musee|⛪ eglise|🗼 tour eiffel paris|🗽 statue liberte new york|🏡 maison jardin|🛏️ lit chambre airbnb location|🔑 cle location|🚪 porte entree"],
  ["Objets",
    "📱 telephone mobile iphone|💻 ordinateur portable|🖥️ ecran ordinateur|⌨️ clavier|🖱️ souris|🖨️ imprimante|💾 disquette sauvegarde|💿 disque|📀 dvd|🎞️ pellicule|📺 television|📻 radio|⏰ reveil alarme|⏱️ chronometre|⌛ sablier attente|📡 antenne|🔋 batterie|🔌 prise|💡 ampoule idee|🔦 lampe|🕯️ bougie|🧯 extincteur|🛠️ outils|🔧 cle reglage|🔨 marteau|⚙️ engrenage reglages parametres|🧰 boite a outils|🔩 vis|🧲 aimant|🧪 tube essai experience test|🔬 microscope recherche|🔭 telescope|💊 medicament|🩺 stethoscope|🧾 facture recu|💰 argent sac|💶 euro billet|💳 carte bancaire paiement|💎 diamant|⚖️ balance justice juridique|🧩 puzzle piece|🔒 cadenas securite verrou|🔓 deverrouille|🔐 securise|🗝️ vieille cle|🛡️ bouclier protection securite|📦 colis paquet livraison|📫 boite aux lettres|✉️ enveloppe courrier mail|📧 email|📨 message recu|📮 poste|🗳️ urne vote|✏️ crayon|🖊️ stylo|🖋️ plume|📎 trombone piece jointe|📏 regle|✂️ ciseaux|🗑️ poubelle corbeille|📋 presse papier liste|📄 page document|📃 page|📑 onglets|📊 graphique barres statistiques|📈 hausse croissance|📉 baisse|🗒️ bloc notes|🗓️ calendrier planning|📇 fiches contacts|📒 cahier|📓 carnet|📔 journal|📕 livre rouge|📗 livre vert|📘 livre bleu|📙 livre orange|📰 journal presse actualite newsletter|🗞️ journal roule|🔖 marque page|🏷️ etiquette tag|🔗 lien chaine|🧷 epingle nourrice"],
  ["Symboles",
    "❤️ coeur amour rouge|🧡 coeur orange|💛 coeur jaune|💚 coeur vert|💙 coeur bleu|💜 coeur violet|🖤 coeur noir|🤍 coeur blanc|💔 coeur brise|❣️ coeur exclamation|💯 cent parfait|✨ etincelles nouveau magie|⭐ etoile|🌟 etoile brillante|💫 vertige|💥 boum|💬 bulle discussion commentaire|💭 pensee|🗯️ colere bulle|🔔 cloche notification rappel|🔕 silence|📢 annonce haut parleur|📣 megaphone communication|🟢 vert ok actif|🟡 jaune attention|🟠 orange|🔴 rouge urgent|🔵 bleu|🟣 violet|⚪ blanc|⚫ noir|🟩 carre vert|🟨 carre jaune|🟥 carre rouge|🟦 carre bleu|❗ exclamation important|❓ question|❕ exclamation blanche|❔ question blanche|⚠️ attention avertissement danger|⛔ interdit stop|🚫 interdit|✔️ coche|☑️ case cochee|✖️ croix|❌ croix non erreur|➕ plus ajouter|➖ moins|➗ diviser|♻️ recyclage|🔁 repeter boucle|🔄 actualiser rafraichir|🔀 aleatoire|▶️ lecture|⏸️ pause|⏹️ stop|⏩ avance rapide|🔜 bientot|🔝 haut top|🆕 nouveau|🆗 ok|🆘 sos aide|ℹ️ information|🔰 debutant|🏁 drapeau arrivee fin|🚩 drapeau signal|🏳️ drapeau blanc|🏴 drapeau noir|🇫🇷 france drapeau|🇪🇺 europe drapeau|🇬🇧 royaume uni drapeau anglais|🇺🇸 etats unis drapeau|🇯🇵 japon drapeau|🔑 cle|♾️ infini|☯️ yin yang|🧿 nazar protection"],
];

export const GROUPES_EMOJI: GroupeEmoji[] = BRUT.map(([nom, s]) => ({
  nom,
  emojis: s.split("|").map((x) => {
    const i = x.indexOf(" ");
    return { e: i === -1 ? x : x.slice(0, i), mots: i === -1 ? "" : x.slice(i + 1) };
  }),
}));

/** Tous les emojis, sans doublon (le premier groupe gagne). */
export const TOUS_EMOJIS: Array<{ e: string; mots: string; groupe: string }> = (() => {
  const vus = new Map<string, { e: string; mots: string; groupe: string }>();
  for (const g of GROUPES_EMOJI) {
    for (const x of g.emojis) {
      const deja = vus.get(x.e);
      if (deja) deja.mots += " " + x.mots;
      else vus.set(x.e, { ...x, groupe: g.nom });
    }
  }
  return [...vus.values()];
})();
