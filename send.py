import json
import os
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request

for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8")


def build_ssl_context():
    ctx = ssl.create_default_context()
    if hasattr(ssl, "enum_certificates"):
        # На Windows встроенный CA-бандл Python не видит корневые
        # сертификаты, добавленные в системное хранилище (например,
        # антивирусом или корпоративным прокси при перехвате TLS).
        # Подмешиваем полное системное хранилище, иначе urlopen падает
        # с CERTIFICATE_VERIFY_FAILED на такой сети.
        for store in ("CA", "ROOT"):
            for cert, encoding, _trust in ssl.enum_certificates(store):
                if encoding == "x509_asn":
                    try:
                        ctx.load_verify_locations(cadata=ssl.DER_cert_to_PEM_cert(cert))
                    except ssl.SSLError:
                        pass
    return ctx


def load_env(path):
    env = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            env[key.strip()] = value.strip()
    return env


def main():
    if len(sys.argv) != 2:
        print('Использование: python send.py "текст сообщения"', file=sys.stderr)
        sys.exit(1)

    text = sys.argv[1]

    env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    env = load_env(env_path)
    token = env.get("TELEGRAM_BOT_TOKEN")
    chat_id = env.get("TELEGRAM_CHAT_ID")

    if not token or not chat_id:
        print("Не заданы TELEGRAM_BOT_TOKEN и/или TELEGRAM_CHAT_ID в .env", file=sys.stderr)
        sys.exit(1)

    url = f"https://api.telegram.org/bot{token}/sendMessage"
    data = urllib.parse.urlencode({"chat_id": chat_id, "text": text}).encode("utf-8")
    request = urllib.request.Request(url, data=data)

    try:
        with urllib.request.urlopen(request, context=build_ssl_context(), timeout=20) as response:
            body = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        print(f"Ошибка Telegram API: {e.code} {e.read().decode('utf-8')}", file=sys.stderr)
        sys.exit(1)
    except urllib.error.URLError as e:
        print(f"Не удалось подключиться к Telegram: {e.reason}", file=sys.stderr)
        sys.exit(1)

    if not body.get("ok"):
        print(f"Telegram API вернул ошибку: {body}", file=sys.stderr)
        sys.exit(1)

    print("Отправлено.")


if __name__ == "__main__":
    main()
