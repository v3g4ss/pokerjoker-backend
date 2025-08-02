const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
require('dotenv').config();

const OpenAI = require('openai');
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const app = express();
const port = process.env.PORT || 3001;

// 🃏 Comedy-DNA laden
let spruecheDaten = [];
try {
  const filePath = path.join(__dirname, 'pokerjoker_bot_data/sprueche_daten.json');
  spruecheDaten = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  console.log('✅ Sprüche-Daten erfolgreich geladen!');
} catch (err) {
  console.warn('⚠️ Sprüche-Daten konnten nicht geladen werden. Der Bot läuft trotzdem weiter.');
}

// Middleware
app.use(cors());
app.use(bodyParser.json());

// 🔥 POST-Route für den Poker Joker
app.post('/api/pokerjoker', async (req, res) => {
  const userMessage = req.body.message;
  console.log('🟢 Eingehende Nachricht vom Frontend:', userMessage);

  const comedyIntro = spruecheDaten.length > 0
    ? `Hier ein Arsenal an Comedy-Kategorien:\n` +
      spruecheDaten.map(e => `🎭 ${e.kategorie}: ${e.kontext} – z.B.: "${e.beispiel}"`).join('\n')
    : 'Nutze deinen Humor, Ironie, kreative Vergleiche und Poker-Memes. Sei locker, frech und unterhaltsam.';

  const systemPrompt = `
Du bist der Comedy-Poker-Bot "Poker Joker". Du antwortest auf Fragen mit Humor, Ironie und Witz.
Dabei nutzt du kreative Comedy-Techniken, um locker, schlagfertig und unterhaltsam zu klingen.

${comedyIntro}
`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ]
    });

    const botReply = completion.choices[0].message.content;
    const totalTokens = completion.usage?.total_tokens || 0;

    console.log('🤖 Poker Joker sagt:', botReply);
    console.log('📊 Verbrauchte Tokens:', totalTokens);

    res.json({ reply: botReply, tokenUsage: totalTokens });

  } catch (error) {
    console.error('🔥 FEHLERKONTROLLE 🔥');
    console.error(error);
    if (error.response?.data) {
      console.error('Fehlerantwort:', error.response.data);
    }
    res.status(500).json({ error: 'Etwas ist schiefgelaufen beim Reden mit dem Poker Joker.' });
  }
});

const inMaintenance = process.env.MAINTENANCE_MODE === 'true'; // <-- Setze auf true bei Wartung und bei live auf false

app.get('*', (req, res) => {
  const fileToSend = inMaintenance
    ? 'maintenance.html'
    : 'index.html';
  res.sendFile(path.join(__dirname, 'public', fileToSend));
});

// Statisches Frontend aus dem public-Ordner serven
app.use(express.static(path.join(__dirname, 'public')));

// Server starten
app.listen(port, () => {
  console.log(`🚀 Poker Joker Backend läuft auf http://localhost:${port}`);
});
