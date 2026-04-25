import os
import json
import uuid
import hashlib
import mimetypes
from datetime import datetime, timezone
import requests
from flask import Flask, request, jsonify, render_template
from werkzeug.utils import secure_filename

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 500 * 1024 * 1024  # 500 MB
app.config['UPLOAD_FOLDER'] = 'uploads'
os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)

CONFIG_FILE = 'config.json'
DESTINATIONS_FILE = 'destinations.json'

ALLOWED_EXTENSIONS = {
    'jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif',
    'mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', '3gp'
}

# ─── Config helpers ────────────────────────────────────────────────────────────

def load_config():
    if os.path.exists(CONFIG_FILE):
        with open(CONFIG_FILE) as f:
            return json.load(f)
    return {"telegram_token": "", "telegram_chat_id": "", "immich_url": "", "immich_api_key": ""}

def save_config(data):
    with open(CONFIG_FILE, 'w') as f:
        json.dump(data, f, indent=2)

def load_destinations():
    if os.path.exists(DESTINATIONS_FILE):
        with open(DESTINATIONS_FILE) as f:
            return json.load(f)
    return []

def save_destinations(data):
    with open(DESTINATIONS_FILE, 'w') as f:
        json.dump(data, f, indent=2)

def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

def is_video(filename):
    ext = filename.rsplit('.', 1)[1].lower()
    return ext in {'mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', '3gp'}

# ─── Routes ────────────────────────────────────────────────────────────────────

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/config', methods=['GET', 'POST'])
def config():
    if request.method == 'GET':
        cfg = load_config()
        # Mask API key
        masked = dict(cfg)
        if masked.get('immich_api_key'):
            masked['immich_api_key'] = masked['immich_api_key'][:8] + '...'
        if masked.get('telegram_token'):
            masked['telegram_token'] = masked['telegram_token'][:10] + '...'
        masked['configured'] = bool(cfg.get('telegram_token') and cfg.get('immich_url') and cfg.get('immich_api_key'))
        return jsonify(masked)
    data = request.json
    cfg = load_config()
    for key in ['telegram_token', 'telegram_chat_id', 'immich_url', 'immich_api_key']:
        if key in data and data[key] and not data[key].endswith('...'):
            cfg[key] = data[key]
    save_config(cfg)
    return jsonify({'ok': True})

@app.route('/api/destinations', methods=['GET', 'POST', 'PUT', 'DELETE'])
def destinations():
    if request.method == 'GET':
        return jsonify(load_destinations())
    if request.method == 'POST':
        data = request.json
        dests = load_destinations()
        dest = {
            'id': str(uuid.uuid4())[:8],
            'name': data['name'],
            'telegram_topic_id': str(data.get('telegram_topic_id', '')),
            'immich_album_id': data.get('immich_album_id', ''),
            'immich_album_name': data.get('immich_album_name', '')
        }
        dests.append(dest)
        save_destinations(dests)
        return jsonify(dest)
    if request.method == 'PUT':
        data = request.json
        dests = load_destinations()
        for d in dests:
            if d['id'] == data.get('id'):
                d['name'] = data.get('name', d['name'])
                d['telegram_topic_id'] = str(data.get('telegram_topic_id', d['telegram_topic_id']))
                d['immich_album_id'] = data.get('immich_album_id', d['immich_album_id'])
                d['immich_album_name'] = data.get('immich_album_name', d.get('immich_album_name', ''))
                break
        save_destinations(dests)
        return jsonify({'ok': True})
    if request.method == 'DELETE':
        dest_id = request.json.get('id')
        dests = [d for d in load_destinations() if d['id'] != dest_id]
        save_destinations(dests)
        return jsonify({'ok': True})

@app.route('/api/immich/albums')
def immich_albums():
    cfg = load_config()
    url = cfg.get('immich_url', '').rstrip('/')
    key = cfg.get('immich_api_key', '')
    if not url or not key:
        return jsonify({'error': 'Immich no configurado'}), 400
    try:
        r = requests.get(f'{url}/api/albums', headers={'x-api-key': key}, timeout=10)
        r.raise_for_status()
        albums = [{'id': a['id'], 'name': a['albumName']} for a in r.json()]
        return jsonify(sorted(albums, key=lambda x: x['name']))
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# Note: Telegram Bot API does NOT have a getForumTopics method.
# Topic IDs (message_thread_id) must be entered manually by the user.
# Users can get them from the topic URL in Telegram Desktop/Web.

@app.route('/api/upload', methods=['POST'])
def upload():
    files = request.files.getlist('files')
    if not files:
        return jsonify({'error': 'No se encontraron archivos'}), 400

    dest_id = request.form.get('destination_id')
    dests = load_destinations()
    dest = next((d for d in dests if d['id'] == dest_id), None)
    if not dest:
        return jsonify({'error': 'Destino no encontrado'}), 400

    cfg = load_config()
    as_docs = request.form.getlist('as_document')

    tg_success = 0
    tg_errors = []
    im_success = 0
    im_errors = []

    for idx, file in enumerate(files):
        if not file.filename or not allowed_file(file.filename):
            tg_errors.append(f"{file.filename}: Tipo de archivo no permitido")
            im_errors.append(f"{file.filename}: Tipo de archivo no permitido")
            continue
            
        filename = secure_filename(file.filename)
        filepath = os.path.join(app.config['UPLOAD_FOLDER'], filename)
        file.save(filepath)

        file_success_tg = False
        file_success_im = False

        # ── Upload to Telegram ─────────────────────────────────────────────────────
        try:
            token = cfg['telegram_token']
            chat_id = cfg['telegram_chat_id']
            topic_id = dest.get('telegram_topic_id')

            video = is_video(filename)
            
            send_as_doc = False
            if idx < len(as_docs) and as_docs[idx] == 'true':
                send_as_doc = True
            
            if send_as_doc:
                method = 'sendDocument'
                field = 'document'
            else:
                method = 'sendVideo' if video else 'sendPhoto'
                field = 'video' if video else 'photo'

            params = {'chat_id': chat_id}
            if topic_id:
                params['message_thread_id'] = topic_id

            with open(filepath, 'rb') as f:
                r = requests.post(
                    f'https://api.telegram.org/bot{token}/{method}',
                    params=params,
                    files={field: (filename, f, mimetypes.guess_type(filename)[0] or 'application/octet-stream')},
                    timeout=120
                )
            data = r.json()
            if data.get('ok'):
                file_success_tg = True
            else:
                tg_errors.append(f'{filename}: {data.get("description", "Error desconocido")}')
        except Exception as e:
            tg_errors.append(f'{filename}: {str(e)}')

        # ── Upload to Immich ───────────────────────────────────────────────────────
        try:
            immich_url = cfg['immich_url'].rstrip('/')
            api_key = cfg['immich_api_key']
            album_id = dest.get('immich_album_id')

            # Compute checksum
            with open(filepath, 'rb') as f:
                checksum = hashlib.sha1(f.read()).hexdigest()

            mime = mimetypes.guess_type(filename)[0] or 'application/octet-stream'

            # Use actual file timestamps to preserve original metadata
            file_mtime = os.path.getmtime(filepath)
            file_dt = datetime.fromtimestamp(file_mtime, tz=timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')

            with open(filepath, 'rb') as f:
                r = requests.post(
                    f'{immich_url}/api/assets',
                    headers={'x-api-key': api_key},
                    data={
                        'deviceAssetId': f'{filename}-{checksum[:8]}',
                        'deviceId': 'media-sync-app',
                        'fileCreatedAt': file_dt,
                        'fileModifiedAt': file_dt,
                    },
                    files={'assetData': (filename, f, mime)},
                    timeout=120
                )

            if r.status_code in (200, 201):
                asset_data = r.json()
                asset_id = asset_data.get('id')

                # Add to album
                if album_id and asset_id:
                    requests.put(
                        f'{immich_url}/api/albums/{album_id}/assets',
                        headers={'x-api-key': api_key, 'Content-Type': 'application/json'},
                        json={'ids': [asset_id]},
                        timeout=10
                    )
                file_success_im = True
            else:
                im_errors.append(f'{filename}: {r.text[:200]}')
        except Exception as e:
            im_errors.append(f'{filename}: {str(e)}')

        # Cleanup
        try:
            os.remove(filepath)
        except Exception:
            pass

        if file_success_tg:
            tg_success += 1
        if file_success_im:
            im_success += 1

    total_errors = len(tg_errors) + len(im_errors)
    total_success = tg_success + im_success

    success = total_errors == 0 and total_success > 0
    partial = total_success > 0 and total_errors > 0

    return jsonify({
        'success': success,
        'partial': partial,
        'results': {
            'telegram': {
                'success_count': tg_success,
                'errors': tg_errors
            },
            'immich': {
                'success_count': im_success,
                'errors': im_errors
            }
        }
    })

@app.route('/api/test', methods=['POST'])
def test_connection():
    service = request.json.get('service')
    cfg = load_config()
    try:
        if service == 'telegram':
            token = cfg.get('telegram_token', '')
            chat_id = cfg.get('telegram_chat_id', '')
            if not token:
                return jsonify({'ok': False, 'error': 'Token del bot no configurado'})
            if not chat_id:
                return jsonify({'ok': False, 'error': 'Chat ID del grupo no configurado'})
            # 1. Verify bot token
            r = requests.get(
                f'https://api.telegram.org/bot{token}/getMe',
                timeout=8
            )
            d = r.json()
            if not d.get('ok'):
                return jsonify({'ok': False, 'error': f'Token inválido: {d.get("description", "error desconocido")}'})
            bot_name = d['result']['username']
            # 2. Verify access to group/chat
            r2 = requests.get(
                f'https://api.telegram.org/bot{token}/getChat',
                params={'chat_id': chat_id},
                timeout=8
            )
            d2 = r2.json()
            if not d2.get('ok'):
                return jsonify({'ok': False, 'error': f'No se pudo acceder al grupo ({chat_id}): {d2.get("description", "error desconocido")}'})
            chat_title = d2.get('result', {}).get('title', chat_id)
            is_forum = d2.get('result', {}).get('is_forum', False)
            forum_status = 'Tópicos activados' if is_forum else '⚠️ Tópicos NO activados'
            return jsonify({'ok': True, 'info': f'Bot: @{bot_name} · Grupo: {chat_title} · {forum_status}'})
        elif service == 'immich':
            r = requests.get(
                f'{cfg["immich_url"].rstrip("/")}/api/users/me',
                headers={'x-api-key': cfg['immich_api_key']},
                timeout=8
            )
            if r.status_code == 200:
                d = r.json()
                return jsonify({'ok': True, 'info': f'Usuario: {d.get("email", "OK")}'})
            return jsonify({'ok': False, 'error': r.text[:100]})
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)})

if __name__ == '__main__':
    print("\n🚀 Media Sync iniciado → http://localhost:5000\n")
    app.run(debug=False, port=5000)
