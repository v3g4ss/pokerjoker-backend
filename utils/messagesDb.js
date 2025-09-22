// ganz oben
const { pool } = require('./db'); // oder dein existierender DB-Pool

// ...
app.post('/contact', async (req, res) => {
  try {
    const { name, email, subject, message } = req.body || {};
    if (!name || !email || !subject || !message) {
      return res.status(400).json({ success: false, message: 'Bitte alle Felder ausfüllen.' });
    }

    // 1) In DB speichern
    await pool.query(
      `INSERT INTO public.messages(name, email, subject, message, created_at)
       VALUES ($1, $2, $3, $4, now())`,
      [name, email, subject, message]
    );

    // 2) Optional: Mail verschicken (wie bisher)
    await transporter.sendMail({
      from: `"${name}" <${email}>`,
      to: process.env.CONTACT_RECEIVER,
      subject,
      text: message
    });

    return res.json({ success: true, message: 'Nachricht erfolgreich gesendet!' });
  } catch (err) {
    console.error('Contact-Fehler:', err);
    return res.status(500).json({ success: false, message: 'Senden fehlgeschlagen!' });
  }
});
