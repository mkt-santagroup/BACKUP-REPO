// Limpa o nome de servidor FiveM, removendo decoracoes, emojis, codigos de cor,
// keywords de promo, texto em arabe (servers SA misturam), prefixos tipo
// "Grand Opening", etc. Usado pelo bot do Discord e pela API REST.

const PROMO_KEYWORDS = [
  'LAUNCH',
  'OPENING', 'OPENS', 'OPENED', 'OPEN',
  'WIPOU', 'WIPED', 'WIPES', 'WIPING', 'WIPE',
  'INAUGURA', 'INAUGUROU', 'INAUGURO',
  'APERTURA', 'ABRIU', 'ABERTURA',
  'COMEBACK',
  'UPDATE', 'UPDATED', 'UPDATES',
  'BEGINNER',
  'NOW', 'TODAY', 'HOJE', 'HOY',
  'SEASON', 'SAISON',
  'DISCORD', 'discord', 'DC\\b',
  'SERVEUR', 'SERVIDOR', 'SERVER',
  'SOBREVIVENCIA', 'APOCALIPSE',
  'SERIOUS', 'SÉRIEUX', 'SERIO', 'sérieux', 'serio',
  'FRESH', 'ECONOMY',
  'GANG\\b',
  'MAKING',
  'SUMMER', 'SPRING', 'AUTUMN', 'WINTER', 'VERAO', 'INVIERNO',
  'BIG', 'FUN',
  'VIBE', 'VIBES',
  'ULTIMATE',
  'EXCLUSIF', 'EXCLUSIVE',
  'NEW',
  'TRAMES', 'UNBAN',
  'ESSAYER', 'TENTER',
  'PROXIMAMENTE', 'PROXIMA', 'PROXIMO',
  'OUT\\b', 'SOON', 'SOON\\b',
  'ENTRA', 'ENTRE', 'ENTREZ', 'ENTRADAS',
  'REBORN', 'RELANC',
  'AIMLAB',
  'PACK',
  'ESTAMOS',
  'EVENTS', 'EVENTO', 'EVENEMENT',
  'ANOS', 'YEARS', 'ANNIVERSARY', 'ANIVERSARIO',
  'PRIVADO', 'PRIVATE',
  'CUSTOM',
  'WL\\b',
  'GROS',
  'AUTOMAT',
  'ADVANCED',
  'LO\\s+QUE', 'LO\\b',
  'SI\\s+EN',
  'GROUP\\b',
];

const PROMO_RE = new RegExp(
  '\\s(?:' +
    PROMO_KEYWORDS.map((p) =>
      p.includes('\\b') || p.includes('\\s')
        ? p
        : p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    ).join('|') +
    ')',
  'i',
);

function cleanCityName(raw = '') {
  let s = raw;

  // 1. Codigos de cor do FiveM (^1, ^2...)
  s = s.replace(/\^[0-9]/g, '');

  // 2. Conteudo entre colchetes/parenteses: [BR], [18+], [FRESH ECONOMY, (anything)
  s = s.replace(/\[[^\]]*\]?/g, ' ');
  s = s.replace(/\([^)]*\)?/g, ' ');

  // 3. Emojis e pictogramas
  s = s.replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}]/gu, ' ');

  // 4. Caracteres decorativos (setas, blocos, traços longos, etc.)
  s = s.replace(
    /[▬═║╗╔↭🡺🡸»«—–⟶⟵◥◤◣◢⌠⌡░▒▓▌▐╣╠╬¦│┃·•★☆◆◇■□●○⤳⤠⮕⮜<>«»―‐‑‒]/g,
    ' ',
  );
  s = s.replace(
    /[\u{2010}-\u{206F}\u{2580}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{1F800}-\u{1F8FF}\u{2900}-\u{297F}]/gu,
    ' ',
  );
  // Zero-width joiners, variation selectors, replacement char
  s = s.replace(/[\u{200B}-\u{200F}\u{FE00}-\u{FE0F}\u{FFFD}]/gu, '');

  // 4.5. Texto em arabe (servers SA misturam Orizon + texto promo arabe)
  s = s.replace(
    /[\u{0600}-\u{06FF}\u{0750}-\u{077F}\u{08A0}-\u{08FF}\u{FB50}-\u{FDFF}\u{FE70}-\u{FEFF}]+/gu,
    ' ',
  );

  // 5. Prefixo "Grand Opening!!" e similares
  s = s.replace(/^\s*(?:GRAND\s+OPENING|GRAND\s+OPEN)\s*!*\s*/i, '');

  // 6. camelCase agressivo: "RoleplayLAUNCHED" -> "Roleplay LAUNCHED"
  s = s.replace(/([a-z])([A-Z]{2,})/g, '$1 $2');

  // 7. Separadores " - ", " | ", " #"
  s = s.split(/\s+[-]\s+/)[0];
  s = s.split('|')[0];
  s = s.split(/\s+#/)[0];

  // 8. Colapsa "RP RP" -> "RP"
  s = s.replace(/\bRP\s+RP\b/gi, 'RP');

  // 9. Corta no primeiro keyword de promo (apos a primeira palavra)
  const m = s.match(PROMO_RE);
  if (m && m.index > 0) s = s.slice(0, m.index);

  // 10. Strip sufixos de data: "14-MAY", "14-05", "MAY 2ND"
  s = s.replace(/\s*\d{1,2}[-/]\w+/g, '');
  s = s.replace(/\s*\d{1,2}(?:ST|ND|RD|TH)\b/gi, '');

  // 11. Marcadores de idade: "18+", "21+"
  s = s.replace(/\s*\b\d{1,2}\+/g, '');

  // 12. Corta em "!!"
  s = s.split('!!')[0];

  // 13. Pontuacao orfa
  s = s.replace(/[!*]+/g, '');
  s = s.replace(/^[\s\-:.,;]+/, '').replace(/[\s\-:.,;]+$/, '');

  // 14. Digito solto no final (1 digito apenas — preserva "LIBERTY 99")
  s = s.replace(/\s+\d\s*$/, '');

  // 15. Chars-lixo no final (nao-letra/digito)
  s = s.replace(/(?:\s+[^\p{L}\p{N}]+)+$/u, '');

  // 16. Colapsa espacos
  s = s.replace(/\s+/g, ' ').trim();

  return s || raw;
}

module.exports = { cleanCityName, PROMO_KEYWORDS };
