# ⚡ Media Sync — Telegram × Immich

Aplicación web local para subir fotos y vídeos simultáneamente a un grupo de Telegram (con tópicos) y a tu servidor Immich.

---

## 🚀 Instalación

### Requisitos
- Python 3.9 o superior
- pip

### Pasos

```bash
# 1. Entra a la carpeta
cd media-sync

# 2. (Opcional pero recomendado) Crea un entorno virtual
python -m venv venv
source venv/bin/activate        # Linux/Mac
venv\Scripts\activate           # Windows

# 3. Instala las dependencias
pip install -r requirements.txt

# 4. Arranca la app
python app.py
```

Abre tu navegador en **http://localhost:5000**

---

## ⚙️ Configuración inicial

### 1. Bot de Telegram

1. Habla con [@BotFather](https://t.me/BotFather) en Telegram
2. Crea un bot con `/newbot` y copia el **token**
3. Añade el bot a tu grupo como **administrador**
4. El grupo debe tener **Tópicos** activados (Ajustes del grupo → Tópicos)
5. Obtén el **Chat ID** del grupo (usa [@getmyid_bot](https://t.me/getmyid_bot) o similar)
   - El Chat ID de un grupo suele ser un número negativo, ej: `-1001234567890`

### 2. Immich

1. Accede a tu Immich → icono de perfil → **Claves API**
2. Crea una nueva clave y cópiala
3. Anota la URL de tu servidor, ej: `http://192.168.1.100:2283`

### 3. Configurar en la app

1. Ve a la pestaña **⚙️ Configuración**
2. Rellena el token, chat ID de Telegram y la URL + API key de Immich
3. Haz clic en **Probar conexión** para verificar
4. Guarda

---

## 📁 Crear destinos

Un "destino" vincula un **álbum de Immich** con un **tópico de Telegram** bajo un mismo nombre.

1. Ve a la pestaña **📁 Destinos**
2. Haz clic en **+ Añadir destino**
3. Pon un nombre (ej: `Vacaciones 2024`)
4. Selecciona el álbum de Immich y el tópico de Telegram correspondientes
5. Guarda

> 💡 **Consejo**: Usa el mismo nombre en el álbum de Immich y en el tópico de Telegram para no confundirte.

---

## 📤 Subir archivos

1. Ve a la pestaña **📤 Subir archivo**
2. Arrastra o selecciona tu foto/vídeo
3. Elige el destino en el desplegable
4. Haz clic en **⚡ Subir a ambas plataformas**

La app sube el archivo a Telegram (en el tópico indicado) y a Immich (en el álbum indicado) de forma simultánea.

---

## 📝 Notas

- Tamaño máximo de archivo: **500 MB** (límite configurable en `app.py`)
- Formatos soportados: JPG, PNG, GIF, WebP, HEIC, MP4, MOV, AVI, MKV, WebM, M4V, 3GP
- Los archivos se eliminan del servidor local tras la subida
- La configuración se guarda en `config.json` y los destinos en `destinations.json`

---

## 🔧 Solución de problemas

| Problema | Solución |
|---|---|
| "El bot no puede enviar al topic" | Asegúrate de que el bot es admin del grupo |
| "Error 403 Immich" | Verifica que la API key tenga permisos de escritura |
| Topics de Telegram no aparecen | El grupo debe tener la función de Foros/Tópicos activada |
| Archivo demasiado grande en Telegram | Telegram limita vídeos a 50 MB vía Bot API |
