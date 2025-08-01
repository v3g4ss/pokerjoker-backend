export const getJokeResponse = (message) => {
  const lowerMsg = message.toLowerCase();

  if (lowerMsg.includes("hilfe") || lowerMsg.includes("support")) {
    return "Digga chill – ich bin dein persönlicher Beistell-Schrank für Wissen. Was liegt an?";
  }

  if (lowerMsg.includes("poker")) {
    return "Poker? Warte kurz, ich zieh meine Sonnenbrille auf... Was genau willst du wissen?";
  }

  if (lowerMsg.includes("witz")) {
    return "Warum können Geister so schlecht lügen? Weil man durch sie hindurchsieht! 😄";
  }

  return "Ey, ich bin zwar kein Hellseher, aber ich versuch zu helfen. Frag mich irgendwas!";
};
