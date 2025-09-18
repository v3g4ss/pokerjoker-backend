from flask import Flask, request, jsonify
import smtplib
from email.mime.text import MIMEText

app = Flask(__name__)

# Deine E-Mail-Konfiguration
MAIL_TO = 'pok3rjok3r@protonmail.com'
MAIL_FROM = 'deineAbsendeAdresse@provider.com'
MAIL_SERVER = 'smtp.provider.com'
MAIL_PORT = 587
MAIL_USER = 'deinSMTPUser'
MAIL_PASS = 'deinSMTPPasswort'

@app.route('/api/contact', methods=['POST'])
def contact():
    data = request.json
    name = data.get('name', '')
    email = data.get('email', '')
    subject = data.get('subject', '')
    msg = data.get('message', '')

    body = f"Name: {name}\nEmail: {email}\n\n{msg}"

    # E-Mail zusammenbauen
    mail = MIMEText(body)
    mail['Subject'] = subject
    mail['From'] = MAIL_FROM
    mail['To'] = MAIL_TO

    try:
        with smtplib.SMTP(MAIL_SERVER, MAIL_PORT) as smtp:
            smtp.starttls()
            smtp.login(MAIL_USER, MAIL_PASS)
            smtp.sendmail(MAIL_FROM, [MAIL_TO], mail.as_string())
        return jsonify({'success': True, 'msg': 'E-Mail gesendet!'})
    except Exception as e:
        print("Mail-Fehler:", e)
        return jsonify({'success': False, 'msg': 'Fehler beim Senden.'}), 500

if __name__ == '__main__':
    app.run(port=5555, debug=True)
