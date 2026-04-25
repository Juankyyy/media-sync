import os
import json
import uuid
import hashlib
import mimetypes
import threading
from datetime import datetime, timezone
import requests
from requests_toolbelt.multipart.encoder import MultipartEncoder, MultipartEncoderMonitor
from flask import Flask, request, jsonify, render_template
from werkzeug.utils import secure_filename

UPLOAD_TASKS = {}

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 2000 * 1024 * 1024  # 2 GB
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

    as_docs = request.form.getlist('as_document')

    # Save locally to be processed in background
    saved_files = []
    for file in files:
        if not file.filename or not allowed_file(file.filename):
            continue
        filename = secure_filename(file.filename)
        filepath = os.path.join(app.config['UPLOAD_FOLDER'], filename)
        file.save(filepath)
        saved_files.append((filename, filepath))
        
    if not saved_files:
        return jsonify({'error': 'No hay archivos válidos para subir'}), 400

    task_id = str(uuid.uuid4())
    UPLOAD_TASKS[task_id] = {
        'status': 'running',
        'tg': {'uploaded': 0, 'total': 0},
        'im': {'uploaded': 0, 'total': 0},
        'results': None
    }
    
    thread = threading.Thread(target=process_upload_task, args=(task_id, saved_files, dest, as_docs))
    thread.daemon = True
    thread.start()

    return jsonify({'task_id': task_id})

@app.route('/api/upload_status/<task_id>', methods=['GET'])
def upload_status(task_id):
    task = UPLOAD_TASKS.get(task_id)
    if not task:
        return jsonify({'error': 'No encontrado'}), 404
    return jsonify(task)

def process_upload_task(task_id, saved_files, dest, as_docs):
    task = UPLOAD_TASKS[task_id]
    cfg = load_config()

    total_size = sum(os.path.getsize(fp) for _, fp in saved_files)
    task['tg'] = {'uploaded': 0, 'total': total_size, 'status': 'running', 'success': 0, 'errors': []}
    task['im'] = {'uploaded': 0, 'total': total_size, 'status': 'running', 'success': 0, 'errors': []}

    def tg_worker():
        tg_success = 0; tg_errors = []
        tg_uploaded_prev = 0
        for idx, (filename, filepath) in enumerate(saved_files):
            file_size = os.path.getsize(filepath)
            try:
                file_size_mb = file_size / (1024 * 1024)
                if file_size_mb > 49.5:
                    tg_errors.append(f'{filename}: Supera el límite de 50MB de Telegram ({file_size_mb:.1f}MB)')
                    tg_uploaded_prev += file_size
                    task['tg']['uploaded'] = tg_uploaded_prev
                    continue

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

                url = f'https://api.telegram.org/bot{token}/{method}?chat_id={chat_id}'
                if topic_id:
                    url += f'&message_thread_id={topic_id}'

                def tg_callback(monitor):
                    task['tg']['uploaded'] = tg_uploaded_prev + monitor.bytes_read

                mime = mimetypes.guess_type(filename)[0] or 'application/octet-stream'
                encoder = MultipartEncoder(fields={
                    field: (filename, open(filepath, 'rb'), mime)
                })
                monitor = MultipartEncoderMonitor(encoder, tg_callback)
                
                r = requests.post(url, data=monitor, headers={'Content-Type': monitor.content_type}, timeout=120)
                
                data = r.json()
                if data.get('ok'):
                    tg_success += 1
                else:
                    tg_errors.append(f'{filename}: {data.get("description", "Error desconocido")}')
            except Exception as e:
                error_msg = str(e)
                if '10054' in error_msg or 'Connection aborted' in error_msg:
                    tg_errors.append(f'{filename}: Se interrumpió la conexión (posiblemente supera el límite de tamaño)')
                else:
                    tg_errors.append(f'{filename}: Error de red ({error_msg[:100]}...)')
            
            tg_uploaded_prev += file_size
            task['tg']['uploaded'] = tg_uploaded_prev
        
        task['tg']['success'] = tg_success
        task['tg']['errors'] = tg_errors
        task['tg']['status'] = 'completed'

    def im_worker():
        im_success = 0; im_errors = []
        im_uploaded_prev = 0
        for idx, (filename, filepath) in enumerate(saved_files):
            file_size = os.path.getsize(filepath)
            try:
                immich_url = cfg['immich_url'].rstrip('/')
                api_key = cfg['immich_api_key']
                album_id = dest.get('immich_album_id')

                with open(filepath, 'rb') as f:
                    checksum = hashlib.sha1(f.read()).hexdigest()

                file_mtime = os.path.getmtime(filepath)
                file_dt = datetime.fromtimestamp(file_mtime, tz=timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')

                def im_callback(monitor):
                    task['im']['uploaded'] = im_uploaded_prev + monitor.bytes_read

                mime = mimetypes.guess_type(filename)[0] or 'application/octet-stream'
                encoder = MultipartEncoder(fields={
                    'deviceAssetId': f'{filename}-{checksum[:8]}',
                    'deviceId': 'media-sync-app',
                    'fileCreatedAt': file_dt,
                    'fileModifiedAt': file_dt,
                    'assetData': (filename, open(filepath, 'rb'), mime)
                })
                monitor = MultipartEncoderMonitor(encoder, im_callback)

                r = requests.post(f'{immich_url}/api/assets', data=monitor, headers={'x-api-key': api_key, 'Content-Type': monitor.content_type}, timeout=120)

                if r.status_code in (200, 201):
                    asset_data = r.json()
                    asset_id = asset_data.get('id')
                    if album_id and asset_id:
                        requests.put(f'{immich_url}/api/albums/{album_id}/assets', headers={'x-api-key': api_key, 'Content-Type': 'application/json'}, json={'ids': [asset_id]}, timeout=10)
                    im_success += 1
                else:
                    im_errors.append(f'{filename}: {r.text[:200]}')
            except Exception as e:
                error_msg = str(e)
                if '10054' in error_msg or 'Connection aborted' in error_msg:
                    im_errors.append(f'{filename}: Se interrumpió la conexión con el servidor (posiblemente por tamaño excesivo o timeout)')
                else:
                    im_errors.append(f'{filename}: Error de red ({error_msg[:100]}...)')

            im_uploaded_prev += file_size
            task['im']['uploaded'] = im_uploaded_prev

        task['im']['success'] = im_success
        task['im']['errors'] = im_errors
        task['im']['status'] = 'completed'

    t1 = threading.Thread(target=tg_worker)
    t2 = threading.Thread(target=im_worker)
    t1.start()
    t2.start()
    t1.join()
    t2.join()

    # Cleanup file
    for _, filepath in saved_files:
        try:
            os.remove(filepath)
        except Exception:
            pass

    task['status'] = 'completed'

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
