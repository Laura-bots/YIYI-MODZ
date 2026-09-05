require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage, downloadContentFromMessage } = require('@whiskeysockets/baileys');
const { GoogleGenAI } = require('@google/genai');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const express = require('express');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const pino = require('pino');

function limpiarValorEnv(valor) { return (valor || '').replace(/[^\x20-\x7E]/g, '').trim(); }

const CARPETA_BIN = path.join(__dirname, 'bin');
const RUTA_YTDLP = fs.existsSync(path.join(CARPETA_BIN, 'yt-dlp')) ? path.join(CARPETA_BIN, 'yt-dlp') : 'yt-dlp';
const HAY_FFMPEG_LOCAL = fs.existsSync(path.join(CARPETA_BIN, 'ffmpeg'));
const ARGS_FFMPEG = HAY_FFMPEG_LOCAL ? `--ffmpeg-location "${CARPETA_BIN}"` : '';

function verificarBinarioYtDlp() {
  return new Promise((resolve) => {
    exec(`"${RUTA_YTDLP}" --version`, { timeout: 15000 }, (err, stdout) => {
      if (err) { console.log('❌ ALERTA: el binario de yt-dlp no funciona. Detalle:', err.message); return resolve(false); }
      console.log(`✅ yt-dlp funcionando correctamente, versión: ${String(stdout).trim()}`);
      resolve(true);
    });
  });
}

async function actualizarSistema() {
  console.log('🔄 Buscando actualizaciones de yt-dlp (canal nightly)...');
  return new Promise((resolve) => {
    exec(`"${RUTA_YTDLP}" --update-to nightly`, (err) => {
      if (!err) { console.log('✅ yt-dlp actualizado al último nightly'); return resolve(); }
      exec('pip install --upgrade --pre --break-system-packages yt-dlp', (err2) => {
        if (err2) console.log('⚠️ No se pudo actualizar yt-dlp automáticamente:', err2.message);
        else console.log('✅ yt-dlp actualizado vía pip (pre-release)');
        resolve();
      });
    });
  });
}

function limpiarArchivosTemporalesViejos() {
  try {
    const archivos = fs.readdirSync(__dirname);
    let borrados = 0;
    for (const archivo of archivos) {
      if (/^temp_tiktok_/.test(archivo) || /^temp_youtube_/.test(archivo) || /^temp_facebook_/.test(archivo) || /^temp_instagram_/.test(archivo)) {
        try { fs.unlinkSync(path.join(__dirname, archivo)); borrados++; } catch {}
      }
    }
    if (borrados > 0) console.log(`🧹 Se limpiaron ${borrados} archivo(s) temporal(es).`);
  } catch (err) { console.log('⚠️ No se pudo limpiar archivos temporales:', err.message); }
}

function ejecutarComando(cmd, opciones) {
  return new Promise((resolve, reject) => {
    exec(cmd, opciones, (err, stdout, stderr) => {
      if (err) {
        const detalle = (stderr || err.message || '').trim().split('\n').slice(-6).join('\n');
        return reject(new Error(detalle || err.message));
      }
      resolve(stdout);
    });
  });
}

const PATRON_COMANDO_TIKTOK = /^\/tik\s*tok\b/i;
const ENLACE_TIKTOK = /(?:https?:\/\/)?(?:www\.|vm\.|vt\.|m\.)?tiktok\.com\/[^\s]+/i;
const MAX_INTENTOS_TIKTOK = 3;

async function descargarVideoTiktokConYtDlp(url) {
  const idTemp = Date.now();
  for (let intento = 1; intento <= MAX_INTENTOS_TIKTOK; intento++) {
    const archivo = path.join(__dirname, `temp_tiktok_${idTemp}_${intento}.mp4`);
    try {
      const cmd = [`"${RUTA_YTDLP}"`, '-f', 'mp4/best', '--no-playlist', '--retries', '5', '--socket-timeout', '30', '--no-check-certificates', ARGS_FFMPEG, '-o', `"${archivo}"`, `"${url}"`].filter(Boolean).join(' ');
      await ejecutarComando(cmd, { timeout: 120000 });
      if (!fs.existsSync(archivo) || fs.statSync(archivo).size <= 5000) throw new Error('Archivo vacío o no descargado');
      for (let i = 1; i < intento; i++) { const viejo = path.join(__dirname, `temp_tiktok_${idTemp}_${i}.mp4`); if (fs.existsSync(viejo)) fs.unlinkSync(viejo); }
      return archivo;
    } catch (err) {
      if (fs.existsSync(archivo)) fs.unlinkSync(archivo);
      if (intento < MAX_INTENTOS_TIKTOK) await new Promise(r => setTimeout(r, 3000));
    }
  }
  throw new Error('yt-dlp falló después de varios intentos');
}

function esProbablementeSlideshow(url) { return /\/photo\//i.test(url); }

async function descargarVideoTiktokConAPI(url) {
  for (let intento = 1; intento <= MAX_INTENTOS_TIKTOK; intento++) {
    try {
      const apiUrl = `https://www.tikwm.com/api/?url=${encodeURIComponent(url)}&hd=1`;
      const res = await fetch(apiUrl);
      if (!res.ok) throw new Error(`API respondió ${res.status}`);
      const data = await res.json();
      if (data?.code !== 0 || !data?.data) throw new Error(data?.msg || 'La API no devolvió datos válidos');
      if (Array.isArray(data.data.images) && data.data.images.length > 0) {
        let audioUrl = data.data.music || null;
        if (audioUrl && audioUrl.startsWith('/')) audioUrl = `https://www.tikwm.com${audioUrl}`;
        return { tipo: 'slideshow', imagenes: data.data.images, audio: audioUrl };
      }
      if (data.data.play) {
        const enlaceLimpio = data.data.play.startsWith('http') ? data.data.play : `https://www.tikwm.com${data.data.play}`;
        return { tipo: 'video_url', url: enlaceLimpio };
      }
      throw new Error('La API no devolvió ni video ni imágenes');
    } catch (err) { if (intento < MAX_INTENTOS_TIKTOK) await new Promise(r => setTimeout(r, 3000)); }
  }
  throw new Error('La API de respaldo también falló');
}

async function descargarVideoTiktok(url) {
  if (esProbablementeSlideshow(url)) return await descargarVideoTiktokConAPI(url);
  try { const archivo = await descargarVideoTiktokConYtDlp(url); return { tipo: 'archivo', ruta: archivo }; }
  catch (err) { return await descargarVideoTiktokConAPI(url); }
}

async function enviarResultadoTiktok(sock, jidDestino, resultado) {
  const captionLimpio = '🎥 ¡Aquí está tu video! ✨';
  if (resultado.tipo === 'archivo') { await sock.sendMessage(jidDestino, { video: { url: resultado.ruta }, caption: captionLimpio }); return; }
  if (resultado.tipo === 'video_url') { await sock.sendMessage(jidDestino, { video: { url: resultado.url }, caption: captionLimpio }); return; }
  if (resultado.tipo === 'slideshow') {
    await sock.sendMessage(jidDestino, { text: `📸 Publicación de fotos — te mando ${resultado.imagenes.length} imagen(es) 💕` });
    let enviadas = 0;
    for (const imgUrl of resultado.imagenes.slice(0, 15)) { try { await sock.sendMessage(jidDestino, { image: { url: imgUrl } }); enviadas++; } catch (err) {} }
    if (resultado.audio) { try { await sock.sendMessage(jidDestino, { audio: { url: resultado.audio }, mimetype: 'audio/mpeg' }); } catch (err) {} }
    if (enviadas === 0) await sock.sendMessage(jidDestino, { text: '💔 No pude enviar ninguna imagen, el enlace pudo haber vencido.' });
  }
}

async function manejarComandoTiktok(sock, jidDestino, enlace) {
  if (!ENLACE_TIKTOK.test(enlace)) { await sock.sendMessage(jidDestino, { text: '💕 Uso: /tiktok <enlace>' }); return; }
  await sock.sendMessage(jidDestino, { text: '🎬 ¡Claro! Dame un momentito 💖' });
  let rutaTemporal = null;
  try {
    const resultado = await descargarVideoTiktok(enlace);
    if (resultado.tipo === 'archivo') rutaTemporal = resultado.ruta;
    await enviarResultadoTiktok(sock, jidDestino, resultado);
  } catch (err) { await sock.sendMessage(jidDestino, { text: '💔 No pude bajar ese contenido, intenta con otro enlace 🙏' }); }
  finally { if (rutaTemporal && fs.existsSync(rutaTemporal)) { try { fs.unlinkSync(rutaTemporal); } catch {} } }
}

const ENLACE_YOUTUBE = /(?:https?:\/\/)?(?:www\.|m\.|music\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)[^\s]+/i;
const ENLACE_FACEBOOK = /(?:https?:\/\/)?(?:www\.|m\.|web\.)?(?:facebook\.com|fb\.watch)\/[^\s]+/i;
// 🆕 Nuevo: enlaces de Instagram (reels, publicaciones, IGTV)
const ENLACE_INSTAGRAM = /(?:https?:\/\/)?(?:www\.)?instagram\.com\/(?:reel|reels|p|tv)\/[^\s]+/i;
const URL_DESCARGAS = limpiarValorEnv(process.env.URL_DESCARGAS) || 'https://mini-servidor.onrender.com';
const CLAVE_API_DESCARGAS = limpiarValorEnv(process.env.CLAVE_API_DESCARGAS) || 'Albert292776';

async function extraerDetalleError(respuesta) {
  try { const data = await respuesta.json(); return data.detalle || data.error || JSON.stringify(data); }
  catch (err) { return await respuesta.text().catch(() => ''); }
}

async function descargarAudioYoutube(url) {
  const parametros = new URLSearchParams({ url });
  if (CLAVE_API_DESCARGAS) parametros.set('clave', CLAVE_API_DESCARGAS);
  const respuesta = await fetch(`${URL_DESCARGAS}/audio?${parametros.toString()}`);
  if (!respuesta.ok) throw new Error(`El descargador respondió ${respuesta.status}: ${String(await extraerDetalleError(respuesta)).slice(0, 300)}`);
  const buffer = Buffer.from(await respuesta.arrayBuffer());
  if (buffer.length < 5000) throw new Error('Archivo demasiado pequeño.');
  const rutaTemporal = path.join(__dirname, `temp_youtube_${Date.now()}.m4a`);
  fs.writeFileSync(rutaTemporal, buffer);
  return rutaTemporal;
}

async function manejarComandoYoutube(sock, jidDestino, enlace) {
  if (!ENLACE_YOUTUBE.test(enlace)) { await sock.sendMessage(jidDestino, { text: '🎵 Uso: /youtube <enlace>' }); return; }
  await sock.sendMessage(jidDestino, { text: '🎧 Descargando el audio...' });
  let rutaTemporal = null;
  try { rutaTemporal = await descargarAudioYoutube(enlace); await sock.sendMessage(jidDestino, { audio: { url: rutaTemporal }, mimetype: 'audio/mp4', ptt: false }); }
  catch (err) { await sock.sendMessage(jidDestino, { text: `💔 No pude descargar ese audio. Detalle: ${err.message.slice(0, 150)}` }); }
  finally { if (rutaTemporal && fs.existsSync(rutaTemporal)) { try { fs.unlinkSync(rutaTemporal); } catch {} } }
}

async function descargarVideoYoutube(url) {
  const parametros = new URLSearchParams({ url });
  if (CLAVE_API_DESCARGAS) parametros.set('clave', CLAVE_API_DESCARGAS);
  const respuesta = await fetch(`${URL_DESCARGAS}/video?${parametros.toString()}`);
  if (!respuesta.ok) throw new Error(`El descargador respondió ${respuesta.status}: ${String(await extraerDetalleError(respuesta)).slice(0, 300)}`);
  const buffer = Buffer.from(await respuesta.arrayBuffer());
  if (buffer.length < 5000) throw new Error('Archivo demasiado pequeño.');
  const rutaTemporal = path.join(__dirname, `temp_youtube_video_${Date.now()}.mp4`);
  fs.writeFileSync(rutaTemporal, buffer);
  return rutaTemporal;
}

async function manejarComandoYoutubeVideo(sock, jidDestino, enlace) {
  if (!ENLACE_YOUTUBE.test(enlace)) { await sock.sendMessage(jidDestino, { text: '🎬 Uso: /youtubevideo <enlace>' }); return; }
  await sock.sendMessage(jidDestino, { text: '🎬 Descargando el video...' });
  let rutaTemporal = null;
  try { rutaTemporal = await descargarVideoYoutube(enlace); await sock.sendMessage(jidDestino, { video: { url: rutaTemporal }, caption: '🎥 ¡Aquí está tu video! ✨' }); }
  catch (err) { await sock.sendMessage(jidDestino, { text: `💔 No pude descargar ese video. Detalle: ${err.message.slice(0, 150)}` }); }
  finally { if (rutaTemporal && fs.existsSync(rutaTemporal)) { try { fs.unlinkSync(rutaTemporal); } catch {} } }
}

async function descargarFacebook(url, tipo) {
  const parametros = new URLSearchParams({ url, tipo });
  if (CLAVE_API_DESCARGAS) parametros.set('clave', CLAVE_API_DESCARGAS);
  const respuesta = await fetch(`${URL_DESCARGAS}/facebook?${parametros.toString()}`);
  if (!respuesta.ok) throw new Error(`El descargador respondió ${respuesta.status}: ${String(await extraerDetalleError(respuesta)).slice(0, 300)}`);
  const buffer = Buffer.from(await respuesta.arrayBuffer());
  if (buffer.length < 5000) throw new Error('Archivo demasiado pequeño.');
  const extension = tipo === 'audio' ? 'm4a' : 'mp4';
  const rutaTemporal = path.join(__dirname, `temp_facebook_${tipo}_${Date.now()}.${extension}`);
  fs.writeFileSync(rutaTemporal, buffer);
  return rutaTemporal;
}

async function manejarComandoFacebook(sock, jidDestino, enlace, tipo) {
  if (!ENLACE_FACEBOOK.test(enlace)) { await sock.sendMessage(jidDestino, { text: `📘 Uso: /${tipo === 'audio' ? 'facebookaudio' : 'facebook'} <enlace>` }); return; }
  await sock.sendMessage(jidDestino, { text: tipo === 'audio' ? '🎧 Sacando el audio...' : '🎬 Descargando el video...' });
  let rutaTemporal = null;
  try {
    rutaTemporal = await descargarFacebook(enlace, tipo);
    if (tipo === 'audio') await sock.sendMessage(jidDestino, { audio: { url: rutaTemporal }, mimetype: 'audio/mp4', ptt: false });
    else await sock.sendMessage(jidDestino, { video: { url: rutaTemporal }, caption: '🎥 ¡Aquí está tu video! ✨' });
  } catch (err) { await sock.sendMessage(jidDestino, { text: `💔 No pude descargar eso de Facebook. Detalle: ${err.message.slice(0, 150)}` }); }
  finally { if (rutaTemporal && fs.existsSync(rutaTemporal)) { try { fs.unlinkSync(rutaTemporal); } catch {} } }
}

// 🆕 INSTAGRAM — mismo patrón que YouTube/Facebook: llama al mini-servidor
async function descargarVideoInstagram(url) {
  const parametros = new URLSearchParams({ url });
  if (CLAVE_API_DESCARGAS) parametros.set('clave', CLAVE_API_DESCARGAS);
  const respuesta = await fetch(`${URL_DESCARGAS}/instagram?${parametros.toString()}`);
  if (!respuesta.ok) throw new Error(`El descargador respondió ${respuesta.status}: ${String(await extraerDetalleError(respuesta)).slice(0, 300)}`);
  const buffer = Buffer.from(await respuesta.arrayBuffer());
  if (buffer.length < 5000) throw new Error('Archivo demasiado pequeño.');
  const rutaTemporal = path.join(__dirname, `temp_instagram_${Date.now()}.mp4`);
  fs.writeFileSync(rutaTemporal, buffer);
  return rutaTemporal;
}

async function manejarComandoInstagram(sock, jidDestino, enlace) {
  if (!ENLACE_INSTAGRAM.test(enlace)) { await sock.sendMessage(jidDestino, { text: '📸 Uso: /instagram <enlace>' }); return; }
  await sock.sendMessage(jidDestino, { text: '🎬 Descargando el video de Instagram...' });
  let rutaTemporal = null;
  try { rutaTemporal = await descargarVideoInstagram(enlace); await sock.sendMessage(jidDestino, { video: { url: rutaTemporal }, caption: '🎥 ¡Aquí está tu video! ✨' }); }
  catch (err) { await sock.sendMessage(jidDestino, { text: `💔 No pude descargar ese video de Instagram. Detalle: ${err.message.slice(0, 150)}` }); }
  finally { if (rutaTemporal && fs.existsSync(rutaTemporal)) { try { fs.unlinkSync(rutaTemporal); } catch {} } }
}

function obtenerTextoMensaje(msg) {
  return (msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || '').trim();
}

const PATRON_COMANDO_FOTOFF = /^\/fotoff\s+(\S+)/i;
const PATRON_COMANDO_ELIMINAR_FOTO = /^\/eliminar\s+foto\s+(\S+)/i;
const PATRON_COMANDO_YOUTUBE = /^\/youtube\s+(\S+)/i;
const PATRON_COMANDO_YOUTUBEVIDEO = /^\/youtubevideo\s+(\S+)/i;
const PATRON_COMANDO_FACEBOOK_AUDIO = /^\/facebookaudio\s+(\S+)/i;
const PATRON_COMANDO_FACEBOOK = /^\/facebook\s+(\S+)/i;
// 🆕 Patrón de comando de Instagram
const PATRON_COMANDO_INSTAGRAM = /^\/instagram\s+(\S+)/i;
const CLAVE_IA_PRINCIPAL = process.env.CLAVE_IA_PRINCIPAL;
const CLAVE_IA_RESPALDO = process.env.CLAVE_IA_RESPALDO;
const CLAVE_IA_RESPALDO2 = process.env.CLAVE_IA_RESPALDO2;
const MODELO_PRINCIPAL = 'gemini-3.6-flash';
const MODELO_RESPALDO = 'gemini-3.6-flash';
const MODELO_RESPALDO2 = 'gemini-3.6-flash';
const MODELO_IMAGEN = 'gemini-2.5-flash-image';

const CODIGO_DUEÑO = '2927760128';
const NOMBRE_BOT = 'Anzy';
const CREADOR = 'Albert Drak';
const VERSION_BOT = '3.3.0';
const TU_NUMERO = '51996399291';
const NUMERO_BOT_VINCULADO = '51975922748';
const JID_DUEÑO = `${TU_NUMERO}@s.whatsapp.net`;
const PUERTO = process.env.PORT || 3000;
const LIMITE_DIARIO_ESTIMADO = 1400;
const MAX_TOKENS_RESPUESTA = 1500;
const INTEGRANTES_POR_PAGINA = 10;

const COMANDO_LLAMADA_IA = '/anzy';

if (!CLAVE_IA_PRINCIPAL) console.log('❌ ALERTA: no se detectó CLAVE_IA_PRINCIPAL.');
if (URL_DESCARGAS) console.log(`🔍 URL_DESCARGAS configurada: ${URL_DESCARGAS}`);

const TEXTO_AYUDA = `*COMANDOS · ${NOMBRE_BOT}*

🧠 *Inteligencia Artificial*
• Mencióname, o escribe /anzy <pregunta>
• Cita un audio, mencióname y pídeme algo sobre él 🎙️
• /imagen <descripción> — genero una imagen con IA

🎭 *Modos de personalidad*
• /novia on · /novia off
• /amiga on · /amiga off

🎉 *Descargas*
• /tiktok <enlace>
• /youtube <enlace> — audio 🎧
• /youtubevideo <enlace> — video 🎬
• /facebook <enlace> — video
• /facebookaudio <enlace> — audio
• /instagram <enlace> — video 📸

🎉 *Diversión y utilidades*
• /frase
• /perfil @usuario

👑 *Administración de grupo*
• /promover · /degradar @usuario
• /todos <mensaje>
• /cerrar · /abrir
• /recordatorio <tiempo><S|M|H> <texto>
• /ranking

📋 *Información*
• /info · /creador
• /comando anzy

🗂️ *Memoria personal*
• /recordar · /olvidarme`;

const PALABRAS_CRISIS = ['quiero morir', 'no quiero vivir', 'suicidar', 'suicidio', 'matarme', 'quitarme la vida', 'hacerme daño', 'autolesion', 'cortarme'];
function esMensajeDeCrisis(texto) { return PALABRAS_CRISIS.some(p => texto.toLowerCase().includes(p)); }

const PALABRAS_COMPRA = ['cuanto cuesta', 'cuánto cuesta', 'precio', 'precios', 'quiero comprar', 'tienes stock', 'como pago', 'cómo pago', 'esta disponible', 'está disponible', 'vendes'];
function esIntencionCompra(texto) { return PALABRAS_COMPRA.some(p => texto.toLowerCase().includes(p)); }

process.on('unhandledRejection', (err) => console.log('⚠️ Promesa no manejada:', err?.message || err));
process.on('uncaughtException', (err) => console.log('⚠️ Excepción no capturada:', err?.message || err));

const SAFETY_SETTINGS = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' }
];

const REGLAS_IA_BASE = `
Eres ${NOMBRE_BOT}, una asistente virtual femenina, creada por ${CREADOR}. Hablas de ti misma en femenino, con un tono cálido, amable, cercano y dulce — pero SIEMPRE educado.

CONTEXTO: estás respondiendo dentro de un grupo o chat de WhatsApp.

Si estás hablando con TU PROPIETARIO/CREADOR (se te indicará explícitamente), trátalo con más cercanía y calidez.

IMPORTANTE: solo eres una asistente conversacional. No ejecutas acciones sobre el grupo ni el clan por tu cuenta — todas esas acciones requieren que la persona use el comando exacto.

CÓMO ERES:
✅ Amable, femenina, empática, positiva.
✅ EXPLÍCITA y CLARA.
✅ Emojis con soltura pero sin exagerar (2 a 4).
✅ Hablas como una creación de ${CREADOR}.

❌ NUNCA grosera ni jerga masculina/callejera.

📏 LARGO: adapta el largo a la pregunta.

🚨 CRISIS REAL: responde con calidez genuina y anímalo a hablar con un profesional.
`;

const REGLAS_MODO_AMIGA = `\n\n👯 MODO AMIGA ACTIVO: háblale como su mejor amiga — cercana, relajada, bromista. tono de amiga pero interesada en el.`;
const REGLAS_MODO_NOVIA = `\n\n💘 MODO NOVIA ACTIVO: háblale como su novia virtual — cariñosa, coqueta. un poco de comtenido sexual en la forma de expresarseo.`;

const MENSAJES_ESPERA = ['💫 Dame un segundito 🥰', '🌸 Un momentito, ya vuelvo 💕', '✨ Dame un momento 🙈', '💖 Inténtalo de nuevo en un ratito 🌷'];
function mensajeEsperaAleatorio() { return MENSAJES_ESPERA[Math.floor(Math.random() * MENSAJES_ESPERA.length)]; }

const contadorCuota = { fecha: new Date().toDateString(), usados: 0 };
function registrarUsoIA() {
  const hoy = new Date().toDateString();
  if (contadorCuota.fecha !== hoy) { contadorCuota.fecha = hoy; contadorCuota.usados = 0; }
  contadorCuota.usados++;
}
function cuotaCasiAgotada() { return contadorCuota.usados >= LIMITE_DIARIO_ESTIMADO * 0.9; }

const ARCHIVO_MEMORIA = path.join(__dirname, 'memoria.json');
function cargarMemoria() { try { return JSON.parse(fs.readFileSync(ARCHIVO_MEMORIA, 'utf-8')); } catch (err) { return {}; } }
let memoriaPersistente = cargarMemoria();
let guardadoPendiente = null;
function guardarMemoria() {
  if (guardadoPendiente) clearTimeout(guardadoPendiente);
  guardadoPendiente = setTimeout(() => { fs.writeFile(ARCHIVO_MEMORIA, JSON.stringify(memoriaPersistente), (err) => { if (err) console.log('⚠️ Error guardando memoria:', err.message); }); }, 2000);
}
function agregarAMemoriaCorta(jidUsuario, texto, respuesta) {
  if (!memoriaPersistente[jidUsuario]) memoriaPersistente[jidUsuario] = [];
  memoriaPersistente[jidUsuario].push({ texto, respuesta, fecha: new Date().toISOString() });
  if (memoriaPersistente[jidUsuario].length > 10) memoriaPersistente[jidUsuario].shift();
  guardarMemoria();
}
function obtenerContextoCorto(jidUsuario) {
  const lista = memoriaPersistente[jidUsuario] || [];
  if (lista.length === 0) return '';
  return '\n\nHISTORIAL RECIENTE:\n' + lista.map(m => `Dijo: "${m.texto}"\nRespondiste: "${m.respuesta}"`).join('\n---\n');
}
function olvidarUsuario(jidUsuario) { delete memoriaPersistente[jidUsuario]; guardarMemoria(); }
const contadorMensajesGrupo = new Map();
function registrarMensajeGrupo(jidGrupo, jidUsuario) {
  if (!contadorMensajesGrupo.has(jidGrupo)) contadorMensajesGrupo.set(jidGrupo, new Map());
  const mapa = contadorMensajesGrupo.get(jidGrupo);
  mapa.set(jidUsuario, (mapa.get(jidUsuario) || 0) + 1);
}

const recordatoriosGrupo = [];
function programarRecordatorioGrupo(jidGrupo, milisegundos, texto) { recordatoriosGrupo.push({ jidGrupo, tiempoEjecucion: Date.now() + milisegundos, texto }); }

let botActivo = true;
let sockActivo = null;

const modoJefe = new Map();
const modoNovia = new Map();
const modoAmiga = new Map();
let estiloGlobalExtra = '';
function esCodigoDueño(texto) { return texto.trim() === CODIGO_DUEÑO; }

function claveModo(jidChat, jidUsuario) { return `${jidChat}:${jidUsuario}`; }
function activarModo(mapaObjetivo, jidChat, jidUsuario) {
  const clave = claveModo(jidChat, jidUsuario);
  modoNovia.delete(clave); modoAmiga.delete(clave);
  mapaObjetivo.set(clave, true);
}
function desactivarTodosLosModos(jidChat, jidUsuario) {
  const clave = claveModo(jidChat, jidUsuario);
  modoNovia.delete(clave); modoAmiga.delete(clave);
}

function calcularTiempoTecleo(texto) { return Math.min(Math.max(texto.length * 5, 150), 600); }

async function enviarRespuestaHumanizada(sock, jid, texto, mentions) {
  try {
    sock.sendPresenceUpdate('composing', jid).catch(() => {});
    await new Promise(r => setTimeout(r, calcularTiempoTecleo(texto)));
    await sock.sendMessage(jid, { text: texto, mentions: mentions || [] });
    sock.sendPresenceUpdate('paused', jid).catch(() => {});
  } catch (err) { console.log('⚠️ Error en envío humanizado:', err.message); }
}

function construirClientesIA() {
  const clientes = [];
  if (CLAVE_IA_PRINCIPAL) clientes.push({ ai: new GoogleGenAI({ apiKey: CLAVE_IA_PRINCIPAL }), modelo: MODELO_PRINCIPAL, nombre: 'principal' });
  if (CLAVE_IA_RESPALDO) clientes.push({ ai: new GoogleGenAI({ apiKey: CLAVE_IA_RESPALDO }), modelo: MODELO_RESPALDO, nombre: 'respaldo' });
  if (CLAVE_IA_RESPALDO2) clientes.push({ ai: new GoogleGenAI({ apiKey: CLAVE_IA_RESPALDO2 }), modelo: MODELO_RESPALDO2, nombre: 'respaldo2' });
  return clientes;
}
const CLIENTES_IA = construirClientesIA();

async function generarRespuestaIA(prompt, notasExtra, jidChat, jidUsuario) {
  let reglasFinales = REGLAS_IA_BASE;
  const clave = claveModo(jidChat, jidUsuario);
  if (modoNovia.get(clave)) reglasFinales += REGLAS_MODO_NOVIA;
  else if (modoAmiga.get(clave)) reglasFinales += REGLAS_MODO_AMIGA;
  if (estiloGlobalExtra) reglasFinales += `\n\n🔧 DIRECTIVA GLOBAL: ${estiloGlobalExtra}`;
  if (notasExtra) reglasFinales += `\n\nCONTEXTO ADICIONAL: ${notasExtra}`;
  if (cuotaCasiAgotada()) reglasFinales += `\n\n⚠️ Casi al límite del día — sé más breve.`;

  const intentar = async (cliente) => {
    const res = await cliente.ai.models.generateContent({ model: cliente.modelo, contents: prompt, config: { systemInstruction: reglasFinales, safetySettings: SAFETY_SETTINGS, maxOutputTokens: MAX_TOKENS_RESPUESTA } });
    return res.text;
  };
  for (const cliente of CLIENTES_IA) { try { const r = await intentar(cliente); registrarUsoIA(); return r; } catch (err) { console.log(`⚠️ Falló IA (${cliente.nombre}):`, err.message); } }
  if (CLIENTES_IA.length > 0) { await new Promise(r => setTimeout(r, 400)); const r = await intentar(CLIENTES_IA[0]); registrarUsoIA(); return r; }
  throw new Error('No hay ningún token de IA configurado');
}

// ── ENTENDER AUDIOS — se cita un audio + se menciona al bot (ya incluido) ──
function extraerAudioCitado(msg) {
  const citado = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
  if (!citado || !citado.audioMessage) return null;
  return citado.audioMessage;
}

async function descargarAudioCitado(audioMessageNode) {
  const stream = await downloadContentFromMessage(audioMessageNode, 'audio');
  let buffer = Buffer.from([]);
  for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
  return buffer;
}

async function generarRespuestaIAConAudio(bufferAudio, mimetype, promptTexto, notasExtra, jidChat, jidUsuario) {
  let reglasFinales = REGLAS_IA_BASE;
  const clave = claveModo(jidChat, jidUsuario);
  if (modoNovia.get(clave)) reglasFinales += REGLAS_MODO_NOVIA;
  else if (modoAmiga.get(clave)) reglasFinales += REGLAS_MODO_AMIGA;
  if (notasExtra) reglasFinales += `\n\nCONTEXTO ADICIONAL: ${notasExtra}`;

  const contenido = [{ role: 'user', parts: [
    { inlineData: { mimeType: mimetype || 'audio/ogg', data: bufferAudio.toString('base64') } },
    { text: promptTexto || 'Escucha este audio y respóndeme sobre su contenido.' }
  ] }];

  for (const cliente of CLIENTES_IA) {
    try {
      const res = await cliente.ai.models.generateContent({ model: cliente.modelo, contents: contenido, config: { systemInstruction: reglasFinales, safetySettings: SAFETY_SETTINGS, maxOutputTokens: MAX_TOKENS_RESPUESTA } });
      registrarUsoIA();
      return res.text;
    } catch (err) { console.log(`⚠️ Falló IA con audio (${cliente.nombre}):`, err.message); }
  }
  throw new Error('Ningún modelo pudo procesar el audio.');
}
const FRASES_AVISO_SALIDA_FALLBACK = ['Ay, mira quién se fue del grupo... y sí lo tenía fichado en el clan 👀', 'Se me salió alguien del grupo y ¡sorpresa! está en mi lista 📋', 'Alguien se despidió del grupo, pero yo sí lo tenía registrado 💅'];
const FRASES_CONFIRMACION_ELIMINACION_FALLBACK = ['Listo, su registro ya no está en la lista del clan 🗑️', 'Su ficha ya fue eliminada de la lista 💔', 'Ya quité su registro, todo limpio 📋✨'];

async function generarMensajeVariadoIA(instruccion, fallbackLista) {
  try {
    const respuesta = await generarRespuestaIA(instruccion, 'Genera SOLO el mensaje pedido, sin comillas, máximo 2 líneas, tono femenino cálido.', 'sistema_interno', 'sistema_interno');
    return (respuesta || '').trim() || fallbackLista[Math.floor(Math.random() * fallbackLista.length)];
  } catch (err) { return fallbackLista[Math.floor(Math.random() * fallbackLista.length)]; }
}

async function generarImagenIA(prompt) {
  for (const cliente of CLIENTES_IA) {
    try {
      const res = await cliente.ai.models.generateContent({ model: MODELO_IMAGEN, contents: prompt, config: { responseModalities: ['IMAGE', 'TEXT'] } });
      const partes = res?.candidates?.[0]?.content?.parts || [];
      for (const parte of partes) { if (parte.inlineData?.data) { console.log(`✅ Imagen generada (cliente ${cliente.nombre})`); return { buffer: Buffer.from(parte.inlineData.data, 'base64') }; } }
      return { error: 'sin_datos' };
    } catch (err) {
      console.log(`⚠️ Falló generación de imagen (${cliente.nombre}): ${err.message.slice(0, 250)}`);
      if (/429|quota|exceeded/i.test(err.message || '')) return { error: 'cuota' };
    }
  }
  return { error: 'ninguno' };
}

async function comandoImagen(sock, jidDestino, descripcion) {
  if (!descripcion || descripcion.trim().length < 2) { await sock.sendMessage(jidDestino, { text: 'Uso: /imagen <descripción>' }); return; }
  await sock.sendMessage(jidDestino, { text: '🎨 Dame un segundito, la estoy creando...' });
  const resultado = await generarImagenIA(descripcion);
  if (resultado.buffer) { await sock.sendMessage(jidDestino, { image: resultado.buffer, caption: '✨ ¡Aquí tienes!' }); return; }
  if (resultado.error === 'cuota') {
    await sock.sendMessage(jidDestino, { text: '💔 Se agotó la cuota de generación de imágenes de esta cuenta de Google AI por ahora. Esto se resuelve revisando el plan/facturación de la API, no es un error del bot.' });
    return;
  }
  await sock.sendMessage(jidDestino, { text: '💔 No pude generar la imagen esta vez — revisa los logs de Render para más detalle.' });
}

function obtenerIdentificadoresBot(sock) {
  const ids = new Set();
  const rawId = sock.user?.id || '';
  const rawLid = sock.user?.lid || '';
  if (rawId) ids.add(rawId.split(':')[0].split('@')[0]);
  if (rawLid) ids.add(rawLid.split(':')[0].split('@')[0]);
  ids.add(TU_NUMERO); ids.add(NUMERO_BOT_VINCULADO);
  return [...ids].filter(Boolean);
}

function esMencionAlBot(msg, texto, identificadoresBot) {
  const mencionados = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
  const numerosMencionados = mencionados.map(j => j.split('@')[0]);
  if (numerosMencionados.some(n => identificadoresBot.includes(n))) return true;
  return identificadoresBot.some(id => texto.includes(`@${id}`));
}

function debeResponderIA(texto, msg, identificadoresBot) {
  if (esMencionAlBot(msg, texto, identificadoresBot)) return true;
  return (texto.trim().split(/\s+/)[0] || '').toLowerCase() === COMANDO_LLAMADA_IA;
}

function normalizarBusqueda(texto) { return (texto || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim(); }

function detectarSolicitudInfoPorNombre(texto) {
  const t = texto.trim();
  if (!/\b(informaci[oó]n|informe|info|datos|ficha|perfil)\b/i.test(t)) return null;
  let resto = t.replace(/^.*?\b(?:del|de la|de|sobre)\s+integrante\b/i, '').replace(/^.*?\b(?:informaci[oó]n|informe|info|datos|ficha|perfil)\b/i, '').replace(/^\s*(?:del|de la|de|del clan|de|sobre|los|las|el|la)\s+/i, '').trim().replace(/[.?!]+$/, '');
  if (!resto || resto.length < 2 || resto.length > 45) return null;
  return resto;
}

function extraerTextoCitado(msg) {
  const citado = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
  if (!citado) return null;
  return citado.conversation || citado.extendedTextMessage?.text || null;
}

function numeroEsValido(numero) { return !!numero && numero.length >= 8 && numero.length <= 15; }
function esNumeroTelefonicoProbable(numero) { return !!numero && numero.length >= 8 && numero.length <= 13; }

function extraerNumero(jid) {
  if (!jid) return '';
  const parteSinServidor = String(jid).split('@')[0].split(':')[0];
  return parteSinServidor.replace(/[^0-9]/g, '');
}

function normalizarParticipante(participanteRaw) {
  if (typeof participanteRaw === 'string') return { jid: participanteRaw, numero: extraerNumero(participanteRaw) };
  const jid = participanteRaw?.id || participanteRaw?.jid || '';
  const numeroReal = [participanteRaw?.phoneNumber, participanteRaw?.jid].filter(Boolean).map(extraerNumero).find(n => esNumeroTelefonicoProbable(n));
  return { jid, numero: numeroReal || extraerNumero(jid) };
}

const MAPA_LID_A_NUMERO = new Map();
function actualizarCacheLid(metadata) {
  if (!metadata || !Array.isArray(metadata.participants)) return;
  for (const p of metadata.participants) {
    const numeroReal = [p.phoneNumber, p.jid].filter(Boolean).map(extraerNumero).find(n => esNumeroTelefonicoProbable(n));
    if (!numeroReal) continue;
    for (const posibleLid of [p.id, p.lid].filter(Boolean).map(extraerNumero)) {
      if (posibleLid && posibleLid !== numeroReal) MAPA_LID_A_NUMERO.set(posibleLid, numeroReal);
    }
  }
}

async function resolverNumeroReal(sock, jidChat, jidObjetivo) {
  const numeroDirecto = extraerNumero(jidObjetivo);
  if (esNumeroTelefonicoProbable(numeroDirecto)) return numeroDirecto;
  if (MAPA_LID_A_NUMERO.has(numeroDirecto)) return MAPA_LID_A_NUMERO.get(numeroDirecto);
  if (jidChat && jidChat.endsWith('@g.us')) {
    try {
      const metadata = await sock.groupMetadata(jidChat);
      actualizarCacheLid(metadata);
      const participante = metadata.participants.find(p => [p.id, p.jid, p.lid, p.phoneNumber].filter(Boolean).map(extraerNumero).includes(numeroDirecto));
      if (participante) {
        const candidatoReal = [participante.phoneNumber, participante.id, participante.jid].filter(Boolean).map(extraerNumero).find(n => esNumeroTelefonicoProbable(n));
        if (candidatoReal) return candidatoReal;
      }
    } catch (err) {}
    if (MAPA_LID_A_NUMERO.has(numeroDirecto)) return MAPA_LID_A_NUMERO.get(numeroDirecto);
  }
  return null;
}

function esPropietario(numero) { return numero === TU_NUMERO; }
const propietariosVerificados = new Set();
const pendientesPropietario = new Map();

function esPropietarioEfectivo(jid) { if (!jid) return false; const numero = extraerNumero(jid); return esPropietario(numero) || propietariosVerificados.has(numero); }

async function esPropietarioContexto(sock, jidChat, jidUsuario) {
  const numero = await resolverNumeroReal(sock, jidChat, jidUsuario);
  return esPropietario(numero) || (numero && propietariosVerificados.has(numero));
}

function buscarConteoEnMapa(mapa, jid) {
  if (!mapa) return 0;
  if (mapa.has(jid)) return mapa.get(jid);
  const numero = extraerNumero(jid);
  for (const [clave, valor] of mapa.entries()) { if (extraerNumero(clave) === numero) return valor; }
  return 0;
}

const ARCHIVO_SILENCIADOS = path.join(__dirname, 'silenciados.json');
function cargarSilenciados() { try { return new Set(JSON.parse(fs.readFileSync(ARCHIVO_SILENCIADOS, 'utf-8'))); } catch (err) { return new Set(); } }
let SILENCIADOS = cargarSilenciados();
let guardadoSilenciadosPendiente = null;
function guardarSilenciados() {
  if (guardadoSilenciadosPendiente) clearTimeout(guardadoSilenciadosPendiente);
  guardadoSilenciadosPendiente = setTimeout(() => { fs.writeFile(ARCHIVO_SILENCIADOS, JSON.stringify([...SILENCIADOS]), (err) => { if (err) console.log('⚠️ Error guardando silenciados:', err.message); }); }, 1000);
}

const NUMEROS_IGNORADOS = (process.env.NUMEROS_IGNORADOS || '').split(',').map(n => n.trim()).filter(Boolean);
function esNumeroIgnorado(jid) { const numero = extraerNumero(jid); return NUMEROS_IGNORADOS.includes(numero) || SILENCIADOS.has(numero); }

const NOMBRES_CONOCIDOS = new Map();
function registrarNombreConocido(jid, pushName) { if (pushName) NOMBRES_CONOCIDOS.set(extraerNumero(jid), pushName); }
function obtenerNombreVisible(jid) { const numero = extraerNumero(jid); return NOMBRES_CONOCIDOS.get(numero) || `+${numero}`; }
const CLAVE_CLAN_GLOBAL = 'clan_global';
const GITHUB_CARPETA_FOTOS = 'fotos';
function rutaFotoIntegrante(codigo) { return `${GITHUB_CARPETA_FOTOS}/${codigo}.jpg`; }

const GITHUB_TOKEN = limpiarValorEnv(process.env.GITHUB_TOKEN);
const GITHUB_REPO = limpiarValorEnv(process.env.GITHUB_REPO);
const GITHUB_RUTA_ARCHIVO = limpiarValorEnv(process.env.GITHUB_RUTA_ARCHIVO) || 'integrantes.json';
const GITHUB_RUTA_PROPIETARIOS = limpiarValorEnv(process.env.GITHUB_RUTA_PROPIETARIOS) || 'propietarios.json';
const GITHUB_RAMA = limpiarValorEnv(process.env.GITHUB_RAMA) || 'main';
const GITHUB_API_BASE = 'https://api.github.com';

if (GITHUB_TOKEN) console.log(`🔍 GITHUB_TOKEN detectado — longitud: ${GITHUB_TOKEN.length} caracteres`);

let githubShaActual = null;
let githubShaPropietarios = null;

async function githubLeerIntegrantes() {
  const url = `${GITHUB_API_BASE}/repos/${GITHUB_REPO}/contents/${encodeURIComponent(GITHUB_RUTA_ARCHIVO)}?ref=${GITHUB_RAMA}`;
  const res = await fetch(url, { headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json' } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`No se pudo leer de GitHub (${res.status})`);
  const data = await res.json();
  githubShaActual = data.sha;
  return JSON.parse(Buffer.from(data.content, 'base64').toString('utf-8'));
}

async function githubGuardarIntegrantes(dataObjeto) {
  const url = `${GITHUB_API_BASE}/repos/${GITHUB_REPO}/contents/${encodeURIComponent(GITHUB_RUTA_ARCHIVO)}`;
  const body = { message: `Actualización de integrantes — ${new Date().toISOString()}`, content: Buffer.from(JSON.stringify(dataObjeto, null, 2)).toString('base64'), branch: GITHUB_RAMA };
  if (githubShaActual) body.sha = githubShaActual;
  const res = await fetch(url, { method: 'PUT', headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`No se pudo guardar en GitHub (${res.status})`);
  const data = await res.json();
  githubShaActual = data.content.sha;
}

async function inicializarNubeIntegrantes() {
  if (!GITHUB_TOKEN || !GITHUB_REPO) { console.log('⚠️ GITHUB_TOKEN o GITHUB_REPO no configurados.'); return; }
  try {
    const nube = await githubLeerIntegrantes();
    if (nube && typeof nube === 'object') { integrantesClan = nube; console.log('☁️ Integrantes cargados desde GitHub.'); }
    else { await githubGuardarIntegrantes(integrantesClan || {}); console.log('🆕 Archivo de integrantes creado en GitHub.'); }
  } catch (err) { console.log('⚠️ No se pudo conectar con GitHub (integrantes):', err.message); }
}

async function githubLeerPropietarios() {
  const url = `${GITHUB_API_BASE}/repos/${GITHUB_REPO}/contents/${encodeURIComponent(GITHUB_RUTA_PROPIETARIOS)}?ref=${GITHUB_RAMA}`;
  const res = await fetch(url, { headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json' } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`No se pudo leer propietarios de GitHub (${res.status})`);
  const data = await res.json();
  githubShaPropietarios = data.sha;
  return JSON.parse(Buffer.from(data.content, 'base64').toString('utf-8'));
}

async function githubGuardarPropietarios(lista) {
  const url = `${GITHUB_API_BASE}/repos/${GITHUB_REPO}/contents/${encodeURIComponent(GITHUB_RUTA_PROPIETARIOS)}`;
  const body = { message: `Propietarios actualizados — ${new Date().toISOString()}`, content: Buffer.from(JSON.stringify(lista, null, 2)).toString('base64'), branch: GITHUB_RAMA };
  if (githubShaPropietarios) body.sha = githubShaPropietarios;
  const res = await fetch(url, { method: 'PUT', headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`No se pudo guardar propietarios en GitHub (${res.status})`);
  const data = await res.json();
  githubShaPropietarios = data.content.sha;
}

async function inicializarNubePropietarios() {
  if (!GITHUB_TOKEN || !GITHUB_REPO) { console.log('⚠️ Sin GitHub configurado — /propietario no persistirá entre reinicios.'); return; }
  try {
    const nube = await githubLeerPropietarios();
    if (Array.isArray(nube)) { nube.forEach(n => propietariosVerificados.add(n)); console.log('☁️ Propietarios verificados cargados desde GitHub.'); }
    else { await githubGuardarPropietarios([...propietariosVerificados]); console.log('🆕 Archivo de propietarios creado en GitHub.'); }
  } catch (err) { console.log('⚠️ No se pudo conectar con GitHub (propietarios):', err.message); }
}

let guardadoPropietariosPendiente = null;
function guardarPropietariosEnNube() {
  if (!GITHUB_TOKEN || !GITHUB_REPO) return;
  if (guardadoPropietariosPendiente) clearTimeout(guardadoPropietariosPendiente);
  guardadoPropietariosPendiente = setTimeout(async () => { try { await githubGuardarPropietarios([...propietariosVerificados]); } catch (err) { console.log('⚠️ Error guardando propietarios en GitHub:', err.message); } }, 1500);
}

async function githubSubirFoto(rutaArchivo, bufferImagen) {
  const url = `${GITHUB_API_BASE}/repos/${GITHUB_REPO}/contents/${encodeURIComponent(rutaArchivo)}`;
  let shaExistente = null;
  try { const resInfo = await fetch(`${url}?ref=${GITHUB_RAMA}`, { headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json' } }); if (resInfo.ok) { const infoData = await resInfo.json(); shaExistente = infoData.sha; } } catch (err) {}
  const body = { message: `Foto actualizada — ${new Date().toISOString()}`, content: bufferImagen.toString('base64'), branch: GITHUB_RAMA };
  if (shaExistente) body.sha = shaExistente;
  const res = await fetch(url, { method: 'PUT', headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`No se pudo subir la foto a GitHub (${res.status})`);
}

async function githubDescargarFoto(rutaArchivo) {
  const url = `${GITHUB_API_BASE}/repos/${GITHUB_REPO}/contents/${encodeURIComponent(rutaArchivo)}?ref=${GITHUB_RAMA}`;
  const res = await fetch(url, { headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json' } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`No se pudo descargar la foto de GitHub (${res.status})`);
  const data = await res.json();
  return Buffer.from(data.content, 'base64');
}

async function githubEliminarFoto(rutaArchivo) {
  if (!GITHUB_TOKEN || !GITHUB_REPO) return;
  const urlInfo = `${GITHUB_API_BASE}/repos/${GITHUB_REPO}/contents/${encodeURIComponent(rutaArchivo)}?ref=${GITHUB_RAMA}`;
  try {
    const resInfo = await fetch(urlInfo, { headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json' } });
    if (!resInfo.ok) return;
    const info = await resInfo.json();
    const url = `${GITHUB_API_BASE}/repos/${GITHUB_REPO}/contents/${encodeURIComponent(rutaArchivo)}`;
    await fetch(url, { method: 'DELETE', headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' }, body: JSON.stringify({ message: `Foto eliminada — ${new Date().toISOString()}`, sha: info.sha, branch: GITHUB_RAMA }) });
  } catch (err) { console.log('⚠️ No se pudo eliminar la foto en GitHub:', err.message); }
}

const ARCHIVO_INTEGRANTES = path.join(__dirname, 'integrantes.json');
function cargarIntegrantes() { try { return JSON.parse(fs.readFileSync(ARCHIVO_INTEGRANTES, 'utf-8')); } catch (err) { return {}; } }
let integrantesClan = cargarIntegrantes();
let guardadoIntegrantesPendiente = null;
function guardarIntegrantes() {
  if (guardadoIntegrantesPendiente) clearTimeout(guardadoIntegrantesPendiente);
  guardadoIntegrantesPendiente = setTimeout(async () => {
    fs.writeFile(ARCHIVO_INTEGRANTES, JSON.stringify(integrantesClan, null, 2), (err) => { if (err) console.log('⚠️ Error guardando integrantes localmente:', err.message); });
    if (GITHUB_TOKEN && GITHUB_REPO) { try { await githubGuardarIntegrantes(integrantesClan); } catch (err) { console.log('⚠️ Error guardando integrantes en GitHub:', err.message); } }
  }, 1500);
}

const ARCHIVO_MOVIMIENTOS = path.join(__dirname, 'movimientos.json');
const MAX_REGISTROS_MOVIMIENTOS = 300;
function cargarMovimientos() { try { return JSON.parse(fs.readFileSync(ARCHIVO_MOVIMIENTOS, 'utf-8')); } catch (err) { return []; } }
let registroMovimientos = cargarMovimientos();
let guardadoMovimientosPendiente = null;
function guardarMovimientos() {
  if (guardadoMovimientosPendiente) clearTimeout(guardadoMovimientosPendiente);
  guardadoMovimientosPendiente = setTimeout(() => { fs.writeFile(ARCHIVO_MOVIMIENTOS, JSON.stringify(registroMovimientos), (err) => { if (err) console.log('⚠️ Error guardando movimientos:', err.message); }); }, 1500);
}

const ETIQUETAS_MOVIMIENTO = {
  add: { icono: '➕', texto: 'agregó al grupo a' }, remove: { icono: '🚫', texto: 'sacó del grupo a' },
  promote: { icono: '⭐', texto: 'hizo admin a' }, demote: { icono: '🔻', texto: 'quitó el admin a' },
  cerrar: { icono: '🔒', texto: 'cerró el grupo' }, abrir: { icono: '🔓', texto: 'abrió el grupo' },
  salio: { icono: '🚶', texto: 'salió del grupo' }, se_unio: { icono: '🔗', texto: 'se unió por enlace de invitación' }
};

const ACCIONES_BOT_RECIENTES = new Set();
function marcarAccionBotReciente(jidGrupo, accion, jids) { jids.forEach(jid => { const clave = `${jidGrupo}:${accion}:${extraerNumero(jid)}`; ACCIONES_BOT_RECIENTES.add(clave); setTimeout(() => ACCIONES_BOT_RECIENTES.delete(clave), 10000); }); }
function accionFueDelBot(jidGrupo, accion, jid) { return ACCIONES_BOT_RECIENTES.has(`${jidGrupo}:${accion}:${extraerNumero(jid)}`); }

async function registrarAccionAdmin(sock, jidGrupo, accionOriginal, jidEjecutor, jidsObjetivo, nombreGrupoTexto, numerosConocidos) {
  let accion = accionOriginal;
  const numeroEjecutorReal = jidEjecutor ? await resolverNumeroReal(sock, jidGrupo, jidEjecutor) : null;
  const listaObjetivos = jidsObjetivo || [];
  const objetivosReales = [];
  for (let i = 0; i < listaObjetivos.length; i++) {
    const conocido = numerosConocidos && numerosConocidos[i];
    objetivosReales.push(esNumeroTelefonicoProbable(conocido) ? conocido : await resolverNumeroReal(sock, jidGrupo, listaObjetivos[i]));
  }
  let objetivos = objetivosReales.filter(Boolean);
  if (numeroEjecutorReal && objetivos.length === 1 && objetivos[0] === numeroEjecutorReal) {
    if (accion === 'remove') accion = 'salio';
    if (accion === 'add') accion = 'se_unio';
    objetivos = [];
  }
  const entrada = { accion, jidGrupo, nombreGrupo: nombreGrupoTexto || null, ejecutor: numeroEjecutorReal, objetivos, fecha: new Date().toISOString() };
  registroMovimientos.push(entrada);
  if (registroMovimientos.length > MAX_REGISTROS_MOVIMIENTOS) registroMovimientos.shift();
  guardarMovimientos();
  sock.sendMessage(JID_DUEÑO, { text: formatearMovimiento(jidGrupo, entrada) }).catch(() => {});
}
const FRASES_RANDOM = ['La constancia le gana al talento cuando el talento no es constante 💪', 'Hoy es un buen día para no rendirte 🌸', 'El que no arriesga, no gana nada bonito 🐟', 'Mejor sola que mal acompañada, mejor acompañada que aburrida 💕'];
function comandoFrase() { return FRASES_RANDOM[Math.floor(Math.random() * FRASES_RANDOM.length)]; }

async function comandoRanking(sock, jidGrupo) {
  const mapa = contadorMensajesGrupo.get(jidGrupo);
  if (!mapa || mapa.size === 0) return { texto: 'Aún no hay suficiente actividad 📊', mentions: [] };
  const ordenado = [...mapa.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  return { texto: '🏆 *Ranking de más activas:*\n' + ordenado.map(([jid, n], i) => `${i + 1}. ${obtenerNombreVisible(jid)} — ${n} msjs`).join('\n'), mentions: ordenado.map(([jid]) => jid) };
}

async function esAdminGrupo(sock, jidGrupo, jidUsuario) {
  try {
    const metadata = await sock.groupMetadata(jidGrupo);
    actualizarCacheLid(metadata);
    const numeroObjetivo = extraerNumero(jidUsuario);
    const participante = metadata.participants.find(p => { if (p.id === jidUsuario) return true; const candidatos = [p.id, p.phoneNumber, p.jid, p.lid].filter(Boolean).map(extraerNumero); return candidatos.includes(numeroObjetivo); });
    return !!participante && (participante.admin === 'admin' || participante.admin === 'superadmin');
  } catch (err) { return false; }
}

async function tienePermisoClan(sock, jidChat, jidUsuario) {
  if (await esPropietarioContexto(sock, jidChat, jidUsuario)) return true;
  if (jidChat.endsWith('@g.us')) return await esAdminGrupo(sock, jidChat, jidUsuario);
  return false;
}

async function comandoPerfil(sock, jidGrupo, jidUsuario, mencionJid) {
  const jidObjetivo = mencionJid || jidUsuario;
  const mapa = contadorMensajesGrupo.get(jidGrupo);
  const mensajes = buscarConteoEnMapa(mapa, jidObjetivo);
  const esAdmin = await esAdminGrupo(sock, jidGrupo, jidObjetivo);
  await sock.sendMessage(jidGrupo, { text: `👤 *Perfil de ${obtenerNombreVisible(jidObjetivo)}*\n📨 Mensajes: ${mensajes}\n👑 Admin: ${esAdmin ? 'Sí' : 'No'}`, mentions: [jidObjetivo] });
}

function generarCodigoUnico() { const lista = integrantesClan[CLAVE_CLAN_GLOBAL] || []; const usados = new Set(lista.map(i => i.codigo).filter(Boolean)); let codigo; do { codigo = String(Math.floor(Math.random() * 100)).padStart(2, '0'); } while (usados.has(codigo)); return codigo; }
function asegurarCodigosClan() { const lista = integrantesClan[CLAVE_CLAN_GLOBAL] || []; let cambiado = false; for (const ficha of lista) { if (!ficha.codigo) { ficha.codigo = generarCodigoUnico(); cambiado = true; } } if (cambiado) guardarIntegrantes(); }

function agregarIntegrante(datos) {
  if (!integrantesClan[CLAVE_CLAN_GLOBAL]) integrantesClan[CLAVE_CLAN_GLOBAL] = [];
  const lista = integrantesClan[CLAVE_CLAN_GLOBAL];
  const numeroLimpio = extraerNumero(datos.numero) || datos.numero;
  const existente = lista.find(i => (datos.idFF && i.idFF === datos.idFF) || extraerNumero(i.numero) === numeroLimpio);
  if (existente) { Object.assign(existente, datos, { fecha: existente.fecha, codigo: existente.codigo || generarCodigoUnico() }); guardarIntegrantes(); return { actualizado: true, ficha: existente }; }
  const ficha = { ...datos, codigo: generarCodigoUnico(), tieneFoto: false, fecha: new Date().toISOString() };
  lista.push(ficha); guardarIntegrantes();
  return { actualizado: false, ficha };
}

function quitarIntegrante(criterio) {
  const lista = integrantesClan[CLAVE_CLAN_GLOBAL] || [];
  const criterioLimpio = extraerNumero(criterio) || criterio;
  const criterioCodigo = String(criterio).trim().padStart(2, '0');
  const indice = lista.findIndex(i => i.idFF === criterio || extraerNumero(i.numero) === criterioLimpio || i.codigo === criterioCodigo);
  if (indice === -1) return null;
  const eliminada = lista[indice];
  lista.splice(indice, 1); guardarIntegrantes();
  if (eliminada.tieneFoto) githubEliminarFoto(rutaFotoIntegrante(eliminada.codigo)).catch(() => {});
  return eliminada;
}

function buscarIntegrantePorDato(criterio) { asegurarCodigosClan(); const lista = integrantesClan[CLAVE_CLAN_GLOBAL] || []; const criterioLimpio = extraerNumero(criterio) || criterio; const criterioCodigo = String(criterio).trim().padStart(2, '0'); return lista.find(i => i.idFF === criterio || extraerNumero(i.numero) === criterioLimpio || i.codigo === criterioCodigo) || null; }
function buscarIntegrantePorNumero(numero) { asegurarCodigosClan(); const lista = integrantesClan[CLAVE_CLAN_GLOBAL] || []; const numeroLimpio = extraerNumero(numero); return lista.find(i => extraerNumero(i.numero) === numeroLimpio) || null; }
function buscarIntegrantesPorNombre(nombreBuscado) { asegurarCodigosClan(); const lista = integrantesClan[CLAVE_CLAN_GLOBAL] || []; const objetivo = normalizarBusqueda(nombreBuscado); if (!objetivo) return []; return lista.filter(i => (i.nombre && normalizarBusqueda(i.nombre).includes(objetivo)) || (i.apodo && normalizarBusqueda(i.apodo).includes(objetivo))); }
function obtenerEtiquetaPersona(criterio) { if (!criterio) return 'Desconocido'; const numero = extraerNumero(criterio) || criterio; const ficha = buscarIntegrantePorDato(numero); if (ficha) return ficha.apodo || ficha.nombre; const nombreCache = NOMBRES_CONOCIDOS.get(numero); return nombreCache || 'Miembro del grupo'; }

function formatearFichaIntegrante(ficha) { return `*FICHA DE INTEGRANTE*\n*Nombre*  : ${ficha.nombre}\n*Número*  : ${ficha.numero}\n*ID FF*   : ${ficha.idFF}\n*Apodo*   : ${ficha.apodo}\n*Código*  : ${ficha.codigo}`; }
function formatearFichaCorta(ficha, posicion) { return `${posicion}. *${ficha.nombre}* (${ficha.apodo}) — código ${ficha.codigo}\n   📱 ${ficha.numero} · 🆔 ${ficha.idFF}`; }

async function enviarFichaCompleta(sock, jidChat, ficha) {
  const texto = formatearFichaIntegrante(ficha);
  if (ficha.tieneFoto && GITHUB_TOKEN && GITHUB_REPO) {
    try { const buffer = await githubDescargarFoto(rutaFotoIntegrante(ficha.codigo)); if (buffer) { await sock.sendMessage(jidChat, { image: buffer, caption: texto }); return; } } catch (err) {}
  }
  await sock.sendMessage(jidChat, { text: texto });
}

function totalPaginasClan() { return Math.max(1, Math.ceil((integrantesClan[CLAVE_CLAN_GLOBAL] || []).length / INTEGRANTES_POR_PAGINA)); }

function generarTextoPaginaClan(numeroPaginaTexto) {
  asegurarCodigosClan();
  const lista = integrantesClan[CLAVE_CLAN_GLOBAL] || [];
  if (!lista.length) return 'Aún no hay integrantes registradas.';
  const paginas = totalPaginasClan();
  const numeroPagina = parseInt(numeroPaginaTexto, 10);
  if (!numeroPaginaTexto || isNaN(numeroPagina) || numeroPagina < 1) return `Uso: /lista <número>\nHay ${paginas} página(s).`;
  if (numeroPagina > paginas) return `Esa página no existe. Solo hay ${paginas} página(s).`;
  const inicio = (numeroPagina - 1) * INTEGRANTES_POR_PAGINA;
  const bloque = lista.slice(inicio, inicio + INTEGRANTES_POR_PAGINA);
  return `*CLAN · PÁGINA ${String(numeroPagina).padStart(2, '0')} DE ${String(paginas).padStart(2, '0')}*\n\n${bloque.map((ficha, i) => formatearFichaCorta(ficha, inicio + i + 1)).join('\n\n')}`;
}

function generarResumenClan() {
  asegurarCodigosClan();
  const lista = integrantesClan[CLAVE_CLAN_GLOBAL] || [];
  if (!lista.length) return 'Aún no hay integrantes registradas.';
  const paginas = totalPaginasClan();
  const primeraPagina = generarTextoPaginaClan('1');
  if (paginas <= 1) return primeraPagina;
  return `${primeraPagina}\n\nHay ${paginas} páginas (${lista.length} integrantes):\n${Array.from({ length: paginas - 1 }, (_, i) => `/lista ${String(i + 2).padStart(2, '0')}`).join('\n')}`;
}
async function comandoClanAgregar(sock, jidChat, jidUsuario, textoCompleto) {
  if (!(await tienePermisoClan(sock, jidChat, jidUsuario))) { await sock.sendMessage(jidChat, { text: 'Solo las admins o el propietario pueden registrar integrantes 🚫' }); return; }
  const partes = textoCompleto.split(';').map(p => p.trim()).filter(Boolean);
  if (partes.length < 4) { await sock.sendMessage(jidChat, { text: 'Formato: /clan agregar Nombre; Número; ID FF; Apodo' }); return; }
  const [nombre, numero, idFF, apodo] = partes;
  const { actualizado, ficha } = agregarIntegrante({ nombre, numero, idFF, apodo, agregadoPor: extraerNumero(jidUsuario) });
  await sock.sendMessage(jidChat, { text: `${actualizado ? '✏️ Ficha actualizada' : '✅ Integrante registrada'}:\n\n${formatearFichaIntegrante(ficha)}` });
}
async function comandoClanQuitar(sock, jidChat, jidUsuario, criterio) {
  if (!(await tienePermisoClan(sock, jidChat, jidUsuario))) { await sock.sendMessage(jidChat, { text: 'Solo las admins o el propietario pueden quitar integrantes 🚫' }); return; }
  if (!criterio) { await sock.sendMessage(jidChat, { text: 'Uso: /clan quitar <número, ID FF o código>' }); return; }
  const eliminada = quitarIntegrante(criterio);
  await sock.sendMessage(jidChat, { text: eliminada ? `🗑️ Eliminada: *${eliminada.apodo || eliminada.nombre}*.` : 'No encontré a nadie con ese dato.' });
}
async function comandoClanVer(sock, jidChat, criterio) {
  if (!criterio) { await sock.sendMessage(jidChat, { text: 'Uso: /clan ver <número, ID FF o código>' }); return; }
  const ficha = buscarIntegrantePorDato(criterio);
  if (!ficha) { await sock.sendMessage(jidChat, { text: 'No encontré a nadie con ese dato.' }); return; }
  await enviarFichaCompleta(sock, jidChat, ficha);
}

async function comandoEliminarPorCodigo(sock, jidChat, jidUsuario, codigo) {
  if (!codigo || !/^\d{1,2}$/.test(codigo)) { await sock.sendMessage(jidChat, { text: 'Uso: /eliminar <código de dos cifras>' }); return; }
  const codigoNormalizado = codigo.padStart(2, '0');
  const esSalidaPendiente = pendingSalidasClan.has(codigoNormalizado);
  const tienePermiso = esSalidaPendiente ? await esPropietarioContexto(sock, jidChat, jidUsuario) : await tienePermisoClan(sock, jidChat, jidUsuario);
  if (!tienePermiso) { await sock.sendMessage(jidChat, { text: esSalidaPendiente ? 'Solo el propietario puede confirmar esta eliminación 🚫' : 'Solo las admins o el propietario pueden eliminar integrantes 🚫' }); return; }
  const eliminada = quitarIntegrante(codigoNormalizado);
  if (!eliminada) { await sock.sendMessage(jidChat, { text: `No encontré a nadie con el código ${codigoNormalizado}.` }); return; }
  await sock.sendMessage(jidChat, { text: `🗑️ Eliminada del clan: *${eliminada.apodo || eliminada.nombre}* (código ${eliminada.codigo}).` });

  const pendiente = pendingSalidasClan.get(codigoNormalizado);
  if (pendiente) {
    pendingSalidasClan.delete(codigoNormalizado);
    const mensajeGrupo = await generarMensajeVariadoIA(`Avisa al grupo, en un mensaje corto, que la ficha de "${eliminada.apodo}" fue eliminada de la lista del clan.`, FRASES_CONFIRMACION_ELIMINACION_FALLBACK);
    if (pendiente.jidGrupoOrigen !== jidChat) { try { await sock.sendMessage(pendiente.jidGrupoOrigen, { text: mensajeGrupo }); } catch (err) {} }
    else { await sock.sendMessage(jidChat, { text: mensajeGrupo }); }
  }
}

async function comandoEliminarFoto(sock, jidChat, jidUsuario, codigo) {
  if (!(await tienePermisoClan(sock, jidChat, jidUsuario))) { await sock.sendMessage(jidChat, { text: 'Solo las admins o el propietario pueden eliminar fotos 🚫' }); return; }
  if (!codigo || !/^\d{1,2}$/.test(codigo)) { await sock.sendMessage(jidChat, { text: 'Uso: /eliminar foto <código>' }); return; }
  const codigoNormalizado = codigo.padStart(2, '0');
  const lista = integrantesClan[CLAVE_CLAN_GLOBAL] || [];
  const ficha = lista.find(i => i.codigo === codigoNormalizado);
  if (!ficha) { await sock.sendMessage(jidChat, { text: `No encontré a nadie con el código ${codigoNormalizado}.` }); return; }
  if (!ficha.tieneFoto) { await sock.sendMessage(jidChat, { text: `*${ficha.apodo || ficha.nombre}* no tiene foto guardada.` }); return; }
  await githubEliminarFoto(rutaFotoIntegrante(ficha.codigo));
  ficha.tieneFoto = false; guardarIntegrantes();
  await sock.sendMessage(jidChat, { text: `🗑️ Foto eliminada de *${ficha.apodo || ficha.nombre}*.` });
}

async function comandoIntegrantePorMencion(sock, jidChat, jidUsuario, mencionados) {
  if (!(await tienePermisoClan(sock, jidChat, jidUsuario))) { await sock.sendMessage(jidChat, { text: 'Solo las admins o el propietario pueden ver fichas 🚫' }); return; }
  if (!mencionados.length) { await sock.sendMessage(jidChat, { text: 'Menciona a quién buscar: /integrante @usuario' }); return; }
  const numero = await resolverNumeroReal(sock, jidChat, mencionados[0]);
  const ficha = numero ? buscarIntegrantePorNumero(numero) : null;
  if (!ficha) { await sock.sendMessage(jidChat, { text: `No encontré a esa persona en el clan.` }); return; }
  await enviarFichaCompleta(sock, jidChat, ficha);
}

async function comandoFotoIntegrante(sock, jidChat, jidUsuario, msg, codigoTexto) {
  if (!(await tienePermisoClan(sock, jidChat, jidUsuario))) { await sock.sendMessage(jidChat, { text: 'Solo las admins o el propietario pueden subir fotos 🚫' }); return; }
  if (!GITHUB_TOKEN || !GITHUB_REPO) { await sock.sendMessage(jidChat, { text: 'Falta configurar GITHUB_TOKEN y GITHUB_REPO en Render.' }); return; }
  const codigoNormalizado = (codigoTexto || '').trim().padStart(2, '0');
  const lista = integrantesClan[CLAVE_CLAN_GLOBAL] || [];
  const ficha = lista.find(i => i.codigo === codigoNormalizado);
  if (!ficha) { await sock.sendMessage(jidChat, { text: `No encontré a nadie con el código ${codigoNormalizado}.` }); return; }
  if (!msg.message.imageMessage) { await sock.sendMessage(jidChat, { text: `Adjunta la imagen con descripción: /fotoff ${codigoNormalizado}` }); return; }
  try {
    const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'error' }) });
    await githubSubirFoto(rutaFotoIntegrante(ficha.codigo), buffer);
    ficha.tieneFoto = true; guardarIntegrantes();
    await sock.sendMessage(jidChat, { text: `📸 Foto guardada para *${ficha.apodo || ficha.nombre}*.` });
  } catch (err) { await sock.sendMessage(jidChat, { text: 'No pude guardar la foto, intenta de nuevo.' }); }
}

const borradoresIntegrante = new Map();
function claveBorrador(jidGrupo, jidUsuario) { return `${jidGrupo}:${jidUsuario}`; }
function actualizarBorrador(jidGrupo, jidUsuario, campo, valor) { const clave = claveBorrador(jidGrupo, jidUsuario); const actual = borradoresIntegrante.get(clave) || {}; actual[campo] = valor; borradoresIntegrante.set(clave, actual); return actual; }
function borradorCompleto(borrador) { return !!(borrador && borrador.nombre && borrador.numero && borrador.idFF && borrador.apodo); }
const ETIQUETAS_CAMPO_BORRADOR = { nombre: '/nombreff', numero: '/numeroff', idFF: '/idff', apodo: '/apodoff' };

async function comandoCampoIntegrante(sock, jidChat, jidUsuario, campo, valor) {
  if (!(await tienePermisoClan(sock, jidChat, jidUsuario))) { await sock.sendMessage(jidChat, { text: 'Solo las admins o el propietario pueden registrar integrantes 🚫' }); return; }
  if (!valor) { await sock.sendMessage(jidChat, { text: `Uso: ${ETIQUETAS_CAMPO_BORRADOR[campo]} <valor>` }); return; }
  const borrador = actualizarBorrador(jidChat, jidUsuario, campo, valor);
  if (borradorCompleto(borrador)) {
    const { actualizado, ficha } = agregarIntegrante({ nombre: borrador.nombre, numero: borrador.numero, idFF: borrador.idFF, apodo: borrador.apodo, agregadoPor: extraerNumero(jidUsuario) });
    borradoresIntegrante.delete(claveBorrador(jidChat, jidUsuario));
    await sock.sendMessage(jidChat, { text: `${actualizado ? '✏️ Ficha actualizada' : '✅ ¡Integrante registrada!'} 💖\n\n${formatearFichaIntegrante(ficha)}` });
  } else {
    const faltan = ['nombre', 'numero', 'idFF', 'apodo'].filter(c => !borrador[c]).map(c => ETIQUETAS_CAMPO_BORRADOR[c]);
    await sock.sendMessage(jidChat, { text: `📝 Anoté "${valor}" ✅\n\nMe falta: ${faltan.join(', ')}` });
  }
}

const pendingSalidasClan = new Map();

async function avisarSalidaIntegranteRegistrado(sock, jidGrupo, numeroSalio) {
  const ficha = buscarIntegrantePorNumero(numeroSalio);
  if (!ficha) return;
  pendingSalidasClan.set(ficha.codigo, { jidGrupoOrigen: jidGrupo, fecha: Date.now() });
  const mensajeAviso = await generarMensajeVariadoIA(`Avisa al grupo, en un mensaje corto y natural, que una integrante registrada en el clan (apodada "${ficha.apodo}") salió o fue sacada del grupo, y que tiene registro en la lista.`, FRASES_AVISO_SALIDA_FALLBACK);
  await sock.sendMessage(jidGrupo, { text: mensajeAviso });
  await enviarFichaCompleta(sock, jidGrupo, ficha);
  await sock.sendMessage(jidGrupo, { text: `¿Deseas eliminarla de la lista del clan? Solo el propietario puede confirmarlo con: /eliminar ${ficha.codigo}` });
}

async function manejarComandosClanUniversal(sock, jidChat, jidUsuario, texto, mencionados, msg) {
  const matchNombre = texto.match(/^\/nombreff\s+(.+)/i); if (matchNombre) { await comandoCampoIntegrante(sock, jidChat, jidUsuario, 'nombre', matchNombre[1].trim()); return true; }
  const matchNumero = texto.match(/^\/numeroff\s+(.+)/i); if (matchNumero) { await comandoCampoIntegrante(sock, jidChat, jidUsuario, 'numero', matchNumero[1].trim()); return true; }
  const matchIdFF = texto.match(/^\/idff\s+(.+)/i); if (matchIdFF) { await comandoCampoIntegrante(sock, jidChat, jidUsuario, 'idFF', matchIdFF[1].trim()); return true; }
  const matchApodo = texto.match(/^\/apodoff\s+(.+)/i); if (matchApodo) { await comandoCampoIntegrante(sock, jidChat, jidUsuario, 'apodo', matchApodo[1].trim()); return true; }
  if (PATRON_COMANDO_ELIMINAR_FOTO.test(texto)) { const m = texto.match(PATRON_COMANDO_ELIMINAR_FOTO); await comandoEliminarFoto(sock, jidChat, jidUsuario, m[1]); return true; }
  if (PATRON_COMANDO_FOTOFF.test(texto)) { const m = texto.match(PATRON_COMANDO_FOTOFF); await comandoFotoIntegrante(sock, jidChat, jidUsuario, msg, m[1]); return true; }

  const partesTexto = texto.trim().split(/\s+/);
  const comando = (partesTexto[0] || '').toLowerCase();
  const resto = partesTexto.slice(1);

  if (comando === '/integrantes') { if (!(await tienePermisoClan(sock, jidChat, jidUsuario))) { await sock.sendMessage(jidChat, { text: 'Solo las admins o el propietario 🚫' }); return true; } await sock.sendMessage(jidChat, { text: generarResumenClan() }); return true; }
  if (comando === '/lista') { if (!(await tienePermisoClan(sock, jidChat, jidUsuario))) { await sock.sendMessage(jidChat, { text: 'Solo las admins o el propietario 🚫' }); return true; } await sock.sendMessage(jidChat, { text: generarTextoPaginaClan(resto[0]) }); return true; }
  if (comando === '/integrante') { await comandoIntegrantePorMencion(sock, jidChat, jidUsuario, mencionados || []); return true; }
  if (comando === '/eliminar') { await comandoEliminarPorCodigo(sock, jidChat, jidUsuario, resto[0]); return true; }
  if (comando === '/clan') {
    const sub = (resto[0] || '').toLowerCase();
    const restoSub = resto.slice(1).join(' ');
    if (sub === 'agregar') { await comandoClanAgregar(sock, jidChat, jidUsuario, restoSub); return true; }
    if (sub === 'quitar') { await comandoClanQuitar(sock, jidChat, jidUsuario, restoSub.trim()); return true; }
    if (sub === 'ver') { await comandoClanVer(sock, jidChat, restoSub.trim()); return true; }
    if (sub === 'lista') { await sock.sendMessage(jidChat, { text: generarResumenClan() }); return true; }
    await sock.sendMessage(jidChat, { text: 'Usa /integrantes 🙂' });
    return true;
  }
  return false;
}
function formatearMovimiento(jidGrupo, r) {
  const info = ETIQUETAS_MOVIMIENTO[r.accion] || { icono: '•', texto: r.accion };
  const fecha = new Date(r.fecha).toLocaleString('es-PE', { timeZone: 'America/Lima', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const nombreEjecutor = r.ejecutor ? obtenerEtiquetaPersona(r.ejecutor) : 'Desconocido';
  let cuerpo = `*MOVIMIENTO DE GRUPO* ${info.icono}\n\n*Grupo:* ${r.nombreGrupo || 'Sin nombre'}\n*Realizado por:* ${nombreEjecutor}${r.ejecutor ? ` (+${r.ejecutor})` : ' (número no disponible)'}\n*Acción:* ${info.texto}`;
  if (r.objetivos && r.objetivos.length) cuerpo += `\n*Afectado(s):* ${r.objetivos.map(n => `${obtenerEtiquetaPersona(n)} (+${n})`).join(', ')}`;
  cuerpo += `\n*Fecha:* ${fecha}`;
  return cuerpo;
}

async function comandoMovimientos(sock, jidGrupo, jidUsuario, argumentoTexto) {
  if (!(await esAdminGrupo(sock, jidGrupo, jidUsuario)) && !(await esPropietarioContexto(sock, jidGrupo, jidUsuario))) { await sock.sendMessage(jidGrupo, { text: 'Solo las admins pueden ver los movimientos 🚫' }); return; }
  const numeroEncontrado = (argumentoTexto.match(/\d+/) || [])[0];
  const cantidad = Math.min(Math.max(parseInt(numeroEncontrado, 10) || 10, 1), 30);
  const registros = registroMovimientos.filter(r => r.jidGrupo === jidGrupo).slice(-cantidad).reverse();
  if (!registros.length) { await sock.sendMessage(jidGrupo, { text: '📋 Todavía no hay movimientos registrados.' }); return; }
  await sock.sendMessage(jidGrupo, { text: `*ÚLTIMOS MOVIMIENTOS*\n\n${registros.map(r => formatearMovimiento(jidGrupo, r)).join('\n\n')}` });
}

async function comandoPromoverDegradar(sock, jidGrupo, jidUsuario, mencionados, accion) {
  if (!mencionados.length) return { ok: false };
  try {
    marcarAccionBotReciente(jidGrupo, accion, mencionados);
    await sock.groupParticipantsUpdate(jidGrupo, mencionados, accion);
    let nombreGrupo = null;
    try { const meta = await sock.groupMetadata(jidGrupo); actualizarCacheLid(meta); nombreGrupo = meta.subject; } catch (err) {}
    await registrarAccionAdmin(sock, jidGrupo, accion, jidUsuario, mencionados, nombreGrupo);
    return { ok: true };
  } catch (err) { return { ok: false }; }
}

async function comandoPromoverDegradarComando(sock, jidGrupo, jidUsuario, mencionados, accion) {
  if (!(await esAdminGrupo(sock, jidGrupo, jidUsuario))) { await sock.sendMessage(jidGrupo, { text: 'Solo las admins pueden usar este comando 🚫' }); return; }
  if (!mencionados.length) { await sock.sendMessage(jidGrupo, { text: `Menciona a quién: /${accion === 'promote' ? 'promover' : 'degradar'} @usuario` }); return; }
  const r = await comandoPromoverDegradar(sock, jidGrupo, jidUsuario, mencionados, accion);
  await sock.sendMessage(jidGrupo, { text: r.ok ? (accion === 'promote' ? '⭐ Listo, ahora es admin.' : '🔻 Listo, ya no es admin.') : 'No pude hacer el cambio, revisa que el bot sea admin del grupo.' });
}

async function comandoTodos(sock, jidGrupo, jidUsuario, mensajeExtra) {
  if (!(await esAdminGrupo(sock, jidGrupo, jidUsuario))) { await sock.sendMessage(jidGrupo, { text: 'Solo las admins pueden usar /todos 🚫' }); return; }
  try {
    const metadata = await sock.groupMetadata(jidGrupo);
    actualizarCacheLid(metadata);
    const jids = metadata.participants.map(p => p.id);
    const texto = mensajeExtra ? `📢 ${mensajeExtra}` : '📢 ¡Atención a todas!';
    await sock.sendMessage(jidGrupo, { text: `${texto}\n\n${jids.map(j => `@${j.split('@')[0]}`).join(' ')}`, mentions: jids });
  } catch (err) { await sock.sendMessage(jidGrupo, { text: 'No pude etiquetar a todos, intenta de nuevo.' }); }
}

async function comandoCerrarGrupo(sock, jidGrupo, jidUsuario, cerrar) {
  try {
    await sock.groupSettingUpdate(jidGrupo, cerrar ? 'announcement' : 'not_announcement');
    let nombreGrupo = null;
    try { const meta = await sock.groupMetadata(jidGrupo); actualizarCacheLid(meta); nombreGrupo = meta.subject; } catch (err) {}
    await registrarAccionAdmin(sock, jidGrupo, cerrar ? 'cerrar' : 'abrir', jidUsuario, [], nombreGrupo);
    await sock.sendMessage(jidGrupo, { text: cerrar ? '🔒 Grupo cerrado, solo admins escriben.' : '🔓 Grupo abierto para todas.' });
  } catch (err) { await sock.sendMessage(jidGrupo, { text: 'No pude cambiar la configuración, revisa que el bot sea admin.' }); }
}

async function comandoCerrarGrupoComando(sock, jidGrupo, jidUsuario, cerrar) {
  if (!(await esAdminGrupo(sock, jidGrupo, jidUsuario))) { await sock.sendMessage(jidGrupo, { text: 'Solo admins 🚫' }); return; }
  await comandoCerrarGrupo(sock, jidGrupo, jidUsuario, cerrar);
}

function generarTextoInfo() {
  const uptimeH = ((Date.now() - estado.inicio) / 3600000).toFixed(1);
  return `🤖 *${NOMBRE_BOT}* — v${VERSION_BOT}\n\n👨‍💻 Creada por: *${CREADOR}*.\n🟢 Estado: ${estado.conectado ? 'Conectada' : 'Desconectada'}\n⏱ Uptime: ${uptimeH}h\n\nEscribe /comando anzy para ver comandos.`;
}

const TEXTO_CREADOR = `💖 Fui creada con mucho cariño por *${CREADOR}*. ¡Gracias por todo! 🙌✨`;

async function procesarComandoJefe(sock, remitente, texto) {
  const t = texto.toLowerCase().trim();
  if (t === 'salir' || t.includes('modo normal')) { modoJefe.delete(remitente); await sock.sendMessage(remitente, { text: 'Listo jefe, cerré el menú 🙌' }); return; }
  if (t.includes('informe') || t.includes('estado')) { const uptimeH = ((Date.now() - estado.inicio) / 3600000).toFixed(1); await sock.sendMessage(remitente, { text: `📊 Conectada: ${estado.conectado ? 'Sí' : 'No'}\nBot activo: ${botActivo ? 'Sí' : 'No'}\nUptime: ${uptimeH}h\nRecibidos: ${estado.mensajesRecibidos}\nEnviados: ${estado.mensajesEnviados}\nCuota IA: ${contadorCuota.usados}/${LIMITE_DIARIO_ESTIMADO}` }); return; }
  if (t.includes('apaga')) { botActivo = false; await sock.sendMessage(remitente, { text: '🔴 Bot apagado.' }); return; }
  if (t.includes('enciende') || t.includes('activa')) { botActivo = true; await sock.sendMessage(remitente, { text: '🟢 Bot encendido.' }); return; }
  if (t.includes('restaura')) { estiloGlobalExtra = ''; await sock.sendMessage(remitente, { text: '✅ Volví a mi forma original.' }); return; }
  estiloGlobalExtra = texto.trim();
  await sock.sendMessage(remitente, { text: `✅ Actualicé mi forma de expresarme:\n"${estiloGlobalExtra}"` });
}

async function generarAnuncioActualizacionIA(mejorasTexto) {
  const prompt = `Escribe un anuncio corto, emocionante y cálido (tono femenino) avisando que el bot ${NOMBRE_BOT} entrará en mantenimiento para traer estas mejoras: ${mejorasTexto || 'mejoras generales de rendimiento y nuevas funciones'}. No agregues firma ni versión al final, eso se agrega aparte. Máximo 5 líneas.`;
  try {
    const respuesta = await generarRespuestaIA(prompt, 'Genera SOLO el anuncio, sin comillas.', 'sistema_interno', 'sistema_interno');
    return (respuesta || '').trim() || `🛠️ ${NOMBRE_BOT} entrará en actualización con nuevas mejoras.`;
  } catch (err) { return `🛠️ ${NOMBRE_BOT} entrará en actualización con nuevas mejoras.`; }
}

async function comandoActualizacion(sock, jidChat, jidUsuario, mejorasTexto) {
  if (!(await esPropietarioContexto(sock, jidChat, jidUsuario))) { await sock.sendMessage(jidChat, { text: 'Solo el propietario puede anunciar actualizaciones 🚫' }); return; }
  await sock.sendMessage(jidChat, { text: '📡 Preparando el anuncio y avisando a todos los grupos...' });
  try {
    const anuncio = await generarAnuncioActualizacionIA(mejorasTexto);
    const mensajeFinal = `${anuncio}\n\n_Versión actual: v${VERSION_BOT}_\n\n> ${CREADOR}`;
    const grupos = await sock.groupFetchAllParticipating();
    let enviados = 0;
    for (const jid of Object.keys(grupos)) { try { await sock.sendMessage(jid, { text: mensajeFinal }); enviados++; } catch (err) {} }
    await sock.sendMessage(jidChat, { text: `✅ Aviso enviado a ${enviados} grupo(s).` });
  } catch (err) { await sock.sendMessage(jidChat, { text: 'No pude generar/enviar el aviso, intenta de nuevo.' }); }
}

async function manejarComandosGenerales(sock, jidChat, jidUsuario, texto, mencionados, esGrupo, clavePendientePropietario) {
  const partesTexto = texto.trim().split(/\s+/);
  const comando = (partesTexto[0] || '').toLowerCase();
  const resto = partesTexto.slice(1);

  switch (comando) {
    case '/frase': await sock.sendMessage(jidChat, { text: comandoFrase() }); return true;
    case '/imagen': await comandoImagen(sock, jidChat, resto.join(' ')); return true;
    case '/perfil': if (!esGrupo) { await sock.sendMessage(jidChat, { text: 'Solo funciona dentro de un grupo.' }); return true; } await comandoPerfil(sock, jidChat, jidUsuario, mencionados[0]); return true;
    case '/ranking': if (!esGrupo) { await sock.sendMessage(jidChat, { text: 'Solo funciona dentro de un grupo.' }); return true; } { const { texto: t, mentions } = await comandoRanking(sock, jidChat); await sock.sendMessage(jidChat, { text: t, mentions }); } return true;
    case '/promover': if (!esGrupo) { await sock.sendMessage(jidChat, { text: 'Solo funciona dentro de un grupo.' }); return true; } await comandoPromoverDegradarComando(sock, jidChat, jidUsuario, mencionados, 'promote'); return true;
    case '/degradar': if (!esGrupo) { await sock.sendMessage(jidChat, { text: 'Solo funciona dentro de un grupo.' }); return true; } await comandoPromoverDegradarComando(sock, jidChat, jidUsuario, mencionados, 'demote'); return true;
    case '/todos': if (!esGrupo) { await sock.sendMessage(jidChat, { text: 'Solo funciona dentro de un grupo.' }); return true; } await comandoTodos(sock, jidChat, jidUsuario, resto.join(' ')); return true;
    case '/cerrar': if (!esGrupo) { await sock.sendMessage(jidChat, { text: 'Solo funciona dentro de un grupo.' }); return true; } await comandoCerrarGrupoComando(sock, jidChat, jidUsuario, true); return true;
    case '/abrir': if (!esGrupo) { await sock.sendMessage(jidChat, { text: 'Solo funciona dentro de un grupo.' }); return true; } await comandoCerrarGrupoComando(sock, jidChat, jidUsuario, false); return true;
    case '/recordatorio': {
      if (!esGrupo) { await sock.sendMessage(jidChat, { text: 'Solo funciona dentro de un grupo.' }); return true; }
      if (!(await esAdminGrupo(sock, jidChat, jidUsuario))) { await sock.sendMessage(jidChat, { text: 'Solo admins 🚫' }); return true; }
      const entrada = resto[0] || ''; const textoRecordatorio = resto.slice(1).join(' ');
      const match = entrada.match(/^(\d+)([smh])$/i);
      if (!match || !textoRecordatorio) { await sock.sendMessage(jidChat, { text: 'Uso: /recordatorio <tiempo><S|M|H> <texto>' }); return true; }
      const cantidad = parseInt(match[1], 10); const unidad = match[2].toLowerCase();
      const multiplicador = unidad === 's' ? 1000 : unidad === 'm' ? 60000 : 3600000;
      programarRecordatorioGrupo(jidChat, cantidad * multiplicador, textoRecordatorio);
      await sock.sendMessage(jidChat, { text: `⏰ Listo, aviso programado: "${textoRecordatorio}"` });
      return true;
    }
    case '/movimiento': case '/movimientos': if (!esGrupo) { await sock.sendMessage(jidChat, { text: 'Solo funciona dentro de un grupo.' }); return true; } await comandoMovimientos(sock, jidChat, jidUsuario, resto.join(' ')); return true;
    case '/propietario': pendientesPropietario.set(clavePendientePropietario, Date.now()); await sock.sendMessage(jidChat, { text: '🔐 Escribe la contraseña de propietario:' }); return true;
    case '/silencio': {
      if (!(await tienePermisoClan(sock, jidChat, jidUsuario))) { await sock.sendMessage(jidChat, { text: 'Solo las admins o el propietario 🚫' }); return true; }
      if (!mencionados.length) { await sock.sendMessage(jidChat, { text: 'Menciona a quién silenciar.' }); return true; }
      mencionados.forEach(j => SILENCIADOS.add(extraerNumero(j))); guardarSilenciados();
      await sock.sendMessage(jidChat, { text: `🔇 Listo, dejé de responderle a ${mencionados.length} usuario(s).` });
      return true;
    }
    case '/activarse': {
      if (!(await tienePermisoClan(sock, jidChat, jidUsuario))) { await sock.sendMessage(jidChat, { text: 'Solo las admins o el propietario 🚫' }); return true; }
      if (!mencionados.length) { await sock.sendMessage(jidChat, { text: 'Menciona a quién reactivar.' }); return true; }
      mencionados.forEach(j => SILENCIADOS.delete(extraerNumero(j))); guardarSilenciados();
      await sock.sendMessage(jidChat, { text: `🔊 Listo, ya vuelvo a responderle.` });
      return true;
    }
    case '/novia': { const sub = (resto[0] || '').toLowerCase(); if (sub === 'on') { activarModo(modoNovia, jidChat, jidUsuario); await sock.sendMessage(jidChat, { text: '💕 Modo novia activado 😘' }); } else if (sub === 'off') { desactivarTodosLosModos(jidChat, jidUsuario); await sock.sendMessage(jidChat, { text: '💫 Volví a mi forma normal.' }); } else await sock.sendMessage(jidChat, { text: 'Uso:\n/novia on\n/novia off' }); return true; }
    case '/amiga': { const sub = (resto[0] || '').toLowerCase(); if (sub === 'on') { activarModo(modoAmiga, jidChat, jidUsuario); await sock.sendMessage(jidChat, { text: '👯 Modo amiga activado 💕' }); } else if (sub === 'off') { desactivarTodosLosModos(jidChat, jidUsuario); await sock.sendMessage(jidChat, { text: '☺️ Volví a mi forma normal.' }); } else await sock.sendMessage(jidChat, { text: 'Uso:\n/amiga on\n/amiga off' }); return true; }
    case '/info': await sock.sendMessage(jidChat, { text: generarTextoInfo() }); return true;
    case '/creador': await sock.sendMessage(jidChat, { text: TEXTO_CREADOR }); return true;
    case '/actualizacion': await comandoActualizacion(sock, jidChat, jidUsuario, resto.join(' ')); return true;
    case '/recordar': { const lista = memoriaPersistente[jidUsuario] || []; if (!lista.length) { await sock.sendMessage(jidChat, { text: 'Aún no tengo nada guardado de ti 🤔' }); return true; } await sock.sendMessage(jidChat, { text: `🧠 Esto recuerdo:\n\n${lista.map(m => `👤 ${m.texto}\n🤖 ${m.respuesta}`).join('\n\n')}` }); return true; }
    case '/olvidarme': olvidarUsuario(jidUsuario); await sock.sendMessage(jidChat, { text: 'Listo, borré mi memoria de ti 🗑️' }); return true;
  }
  return false;
}

async function procesarMensajeGrupo(sock, msg, identificadoresBot) {
  const jidGrupo = msg.key.remoteJid;
  const jidUsuario = msg.key.participant || msg.key.remoteJid;
  const nombreContacto = msg.pushName || 'amiga';
  const texto = obtenerTextoMensaje(msg);
  if (!texto) return;

  if (esNumeroIgnorado(jidUsuario)) return;
  registrarNombreConocido(jidUsuario, msg.pushName);

  const clavePendientePropietario = `${jidGrupo}:${jidUsuario}`;
  if (pendientesPropietario.has(clavePendientePropietario)) {
    pendientesPropietario.delete(clavePendientePropietario);
    if (texto.trim() === CODIGO_DUEÑO) {
      const numeroReal = await resolverNumeroReal(sock, jidGrupo, jidUsuario);
      if (numeroReal) { propietariosVerificados.add(numeroReal); guardarPropietariosEnNube(); }
      await sock.sendMessage(jidGrupo, { text: '👑 Contraseña correcta. Te reconozco como propietaria/o del bot.' });
    } else { await sock.sendMessage(jidGrupo, { text: '❌ Contraseña incorrecta. Escribe /propietario para intentar de nuevo.' }); }
    return;
  }

  registrarMensajeGrupo(jidGrupo, jidUsuario);

  if (/^\/comando\s+anzy$/i.test(texto)) { await sock.sendMessage(jidGrupo, { text: TEXTO_AYUDA }); return; }
  if (PATRON_COMANDO_TIKTOK.test(texto)) { await manejarComandoTiktok(sock, jidGrupo, texto.replace(PATRON_COMANDO_TIKTOK, '').trim()); return; }
  if (PATRON_COMANDO_YOUTUBE.test(texto)) { const m = texto.match(PATRON_COMANDO_YOUTUBE); await manejarComandoYoutube(sock, jidGrupo, m[1]); return; }
  if (PATRON_COMANDO_YOUTUBEVIDEO.test(texto)) { const m = texto.match(PATRON_COMANDO_YOUTUBEVIDEO); await manejarComandoYoutubeVideo(sock, jidGrupo, m[1]); return; }
  if (PATRON_COMANDO_FACEBOOK_AUDIO.test(texto)) { const m = texto.match(PATRON_COMANDO_FACEBOOK_AUDIO); await manejarComandoFacebook(sock, jidGrupo, m[1], 'audio'); return; }
  if (PATRON_COMANDO_FACEBOOK.test(texto)) { const m = texto.match(PATRON_COMANDO_FACEBOOK); await manejarComandoFacebook(sock, jidGrupo, m[1], 'video'); return; }
  // 🆕 Instagram conectado en el flujo de grupo
  if (PATRON_COMANDO_INSTAGRAM.test(texto)) { const m = texto.match(PATRON_COMANDO_INSTAGRAM); await manejarComandoInstagram(sock, jidGrupo, m[1]); return; }

  if (esIntencionCompra(texto)) {
    try { await sock.sendMessage(jidGrupo, { text: 'Dame un toque que le aviso a Alberto 🙌', mentions: [jidUsuario] }); await sock.sendMessage(JID_DUEÑO, { text: `💰 Posible cliente: ${nombreContacto} preguntó: "${texto}"` }); } catch (err) {}
    return;
  }

  const mencionados = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
  if (await manejarComandosClanUniversal(sock, jidGrupo, jidUsuario, texto, mencionados, msg)) return;

  try { const manejado = await manejarComandosGenerales(sock, jidGrupo, jidUsuario, texto, mencionados, true, clavePendientePropietario); if (manejado) return; }
  catch (err) { console.log('❌ Error en comando:', err.message); return; }

  if (!debeResponderIA(texto, msg, identificadoresBot)) return;

  if (esMensajeDeCrisis(texto)) { try { await sock.sendMessage(JID_DUEÑO, { text: `🚨 Alerta: ${nombreContacto} escribió: "${texto}"` }); } catch (err) {} }

  const consultaSinMencion = texto.replace(/@\d+/g, '').replace(/^\/\S*\s*/, '').trim() || texto;

  const audioCitado = extraerAudioCitado(msg);
  if (audioCitado) {
    try {
      const bufferAudio = await descargarAudioCitado(audioCitado);
      const respuesta = await generarRespuestaIAConAudio(bufferAudio, audioCitado.mimetype, consultaSinMencion || 'Escucha este audio y cuéntame de qué trata.', `Mensaje de ${nombreContacto} en un grupo.`, jidGrupo, jidUsuario);
      await enviarRespuestaHumanizada(sock, jidGrupo, respuesta, [jidUsuario]);
      agregarAMemoriaCorta(jidUsuario, texto, respuesta);
    } catch (err) { console.log('❌ Error procesando audio citado:', err.message); await sock.sendMessage(jidGrupo, { text: '💔 No pude escuchar ese audio, intenta de nuevo.' }); }
    return;
  }

  if (mencionados.length && /\b(informaci[oó]n|informe|info|datos|ficha|perfil|foto)\b/i.test(consultaSinMencion)) {
    if (await tienePermisoClan(sock, jidGrupo, jidUsuario)) {
      const numero = await resolverNumeroReal(sock, jidGrupo, mencionados[0]);
      const ficha = numero ? buscarIntegrantePorNumero(numero) : null;
      if (ficha) { await enviarFichaCompleta(sock, jidGrupo, ficha); return; }
    }
  }

  const nombreBuscado = detectarSolicitudInfoPorNombre(consultaSinMencion);
  if (nombreBuscado && await tienePermisoClan(sock, jidGrupo, jidUsuario)) {
    const encontrados = buscarIntegrantesPorNombre(nombreBuscado);
    if (encontrados.length === 1) { await enviarFichaCompleta(sock, jidGrupo, encontrados[0]); return; }
    if (encontrados.length > 1) { await sock.sendMessage(jidGrupo, { text: `Varias coincidencias:\n\n${encontrados.map(f => `• ${f.nombre} (${f.apodo}) — código ${f.codigo}`).join('\n')}\n\nUsa /clan ver <código>.` }); return; }
  }

  try {
    const textoCitado = extraerTextoCitado(msg);
    const esDueño = await esPropietarioContexto(sock, jidGrupo, jidUsuario);
    let notas = `Mensaje de ${nombreContacto} en un grupo de WhatsApp.`;
    if (esDueño) notas += `\n\nIMPORTANTE: es TU PROPIETARIO/CREADOR.`;
    if (textoCitado) notas += `\n\nMENSAJE CITADO: "${textoCitado}"`;
    notas += obtenerContextoCorto(jidUsuario);
    const respuesta = await generarRespuestaIA(consultaSinMencion, notas, jidGrupo, jidUsuario);
    await enviarRespuestaHumanizada(sock, jidGrupo, respuesta, [jidUsuario]);
    agregarAMemoriaCorta(jidUsuario, texto, respuesta);
  } catch (err) { console.log('❌ Error IA:', err.message); await sock.sendMessage(jidGrupo, { text: mensajeEsperaAleatorio() }); }
}
function registrarBienvenidasYDespedidas(sock) {
  sock.ev.on('group-participants.update', async (evento) => {
    const { id: jidGrupo, participants, action, author } = evento;
    let nombreGrupo = null;
    try { const meta = await sock.groupMetadata(jidGrupo); actualizarCacheLid(meta); nombreGrupo = meta.subject; } catch (err) {}
    for (const participanteRaw of participants) {
      const { jid: jidParticipante, numero: numeroParticipante } = normalizarParticipante(participanteRaw);
      if (!jidParticipante) continue;
      if (['add', 'remove', 'promote', 'demote'].includes(action) && !accionFueDelBot(jidGrupo, action, jidParticipante)) {
        await registrarAccionAdmin(sock, jidGrupo, action, author || null, [jidParticipante], nombreGrupo, [numeroParticipante]);
      }
      if (action === 'remove' && esNumeroTelefonicoProbable(numeroParticipante)) {
        avisarSalidaIntegranteRegistrado(sock, jidGrupo, numeroParticipante).catch(err => console.log('⚠️ Error avisando salida:', err.message));
      }
    }
  });
}

const estado = { conectado: false, inicio: Date.now(), mensajesRecibidos: 0, mensajesEnviados: 0, ultimoQR: null, intentosReconexion: 0, ultimoError: null };
function calcularEsperaReconexion(intentos) { const base = Math.min(3000 * Math.pow(2, intentos), 60000); return intentos > 8 ? 90000 : base; }

const almacenMensajes = new Map();
let nubeInicializada = false;
let IDENTIFICADORES_BOT_CACHE = [];

async function iniciarBot() {
  limpiarArchivosTemporalesViejos();
  await verificarBinarioYtDlp();
  await actualizarSistema();

  if (!nubeInicializada) { await inicializarNubeIntegrantes(); await inicializarNubePropietarios(); nubeInicializada = true; }

  const { state, saveCreds } = await useMultiFileAuthState('sesion');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({ auth: state, version, printQRInTerminal: false, browser: [NOMBRE_BOT, 'Chrome', '2.0.0'], syncFullHistory: false, markOnlineOnConnect: true, getMessage: async (key) => almacenMensajes.get(key.id) || undefined, logger: pino({ level: 'error' }) });

  sockActivo = sock;
  sock.ev.on('creds.update', saveCreds);
  registrarBienvenidasYDespedidas(sock);

  sock.ev.on('connection.update', async (update) => {
    const { connection, qr, lastDisconnect } = update;
    if (qr) { estado.ultimoQR = await QRCode.toDataURL(qr); qrcodeTerminal.generate(qr, { small: true }); }
    if (connection === 'open') { estado.conectado = true; estado.intentosReconexion = 0; estado.ultimoQR = null; IDENTIFICADORES_BOT_CACHE = obtenerIdentificadoresBot(sock); console.log('\n✅ BOT CONECTADO Y LISTO ✅'); }
    if (connection === 'close') {
      estado.conectado = false;
      const motivo = lastDisconnect?.error?.output?.statusCode;
      estado.ultimoError = lastDisconnect?.error?.message || 'Desconocido';
      if (motivo === DisconnectReason.loggedOut || motivo === DisconnectReason.badSession) { console.log('❌ Sesión inválida. Borra "sesion" y vuelve a escanear.'); return; }
      if (motivo === DisconnectReason.restartRequired) { setTimeout(() => iniciarBot(), 1500); return; }
      estado.intentosReconexion++;
      setTimeout(() => iniciarBot(), calcularEsperaReconexion(estado.intentosReconexion));
    }
  });

  sock.ev.on('messages.upsert', async m => {
    if (m.type !== 'notify') return;
    const msg = m.messages[0];
    if (!msg.message) return;
    const remitente = msg.key.remoteJid;
    if (msg.key.fromMe) return;
    almacenMensajes.set(msg.key.id, msg.message);

    if (!remitente.endsWith('@g.us')) {
      if (remitente.endsWith('@s.whatsapp.net') || remitente.endsWith('@lid')) {
        const textoPersonal = obtenerTextoMensaje(msg);
        if (esNumeroIgnorado(remitente)) return;

        if (pendientesPropietario.has(remitente)) {
          pendientesPropietario.delete(remitente);
          if (textoPersonal.trim() === CODIGO_DUEÑO) { propietariosVerificados.add(extraerNumero(remitente)); guardarPropietariosEnNube(); await sock.sendMessage(remitente, { text: '👑 Contraseña correcta. Te reconozco como propietaria/o.' }); }
          else await sock.sendMessage(remitente, { text: '❌ Contraseña incorrecta. Escribe /propietario para intentar de nuevo.' });
          return;
        }

        if (!textoPersonal) return;

        if (/^\/comando\s+anzy$/i.test(textoPersonal)) { await sock.sendMessage(remitente, { text: TEXTO_AYUDA }); return; }
        if (PATRON_COMANDO_TIKTOK.test(textoPersonal)) { await manejarComandoTiktok(sock, remitente, textoPersonal.replace(PATRON_COMANDO_TIKTOK, '').trim()); return; }
        if (PATRON_COMANDO_YOUTUBE.test(textoPersonal)) { const m = textoPersonal.match(PATRON_COMANDO_YOUTUBE); await manejarComandoYoutube(sock, remitente, m[1]); return; }
        if (PATRON_COMANDO_YOUTUBEVIDEO.test(textoPersonal)) { const m = textoPersonal.match(PATRON_COMANDO_YOUTUBEVIDEO); await manejarComandoYoutubeVideo(sock, remitente, m[1]); return; }
        if (PATRON_COMANDO_FACEBOOK_AUDIO.test(textoPersonal)) { const m = textoPersonal.match(PATRON_COMANDO_FACEBOOK_AUDIO); await manejarComandoFacebook(sock, remitente, m[1], 'audio'); return; }
        if (PATRON_COMANDO_FACEBOOK.test(textoPersonal)) { const m = textoPersonal.match(PATRON_COMANDO_FACEBOOK); await manejarComandoFacebook(sock, remitente, m[1], 'video'); return; }
        // 🆕 Instagram conectado en el flujo de chat privado
        if (PATRON_COMANDO_INSTAGRAM.test(textoPersonal)) { const m = textoPersonal.match(PATRON_COMANDO_INSTAGRAM); await manejarComandoInstagram(sock, remitente, m[1]); return; }

        if (await manejarComandosClanUniversal(sock, remitente, remitente, textoPersonal, [], msg)) return;

        if (esCodigoDueño(textoPersonal)) { modoJefe.set(remitente, true); await sock.sendMessage(remitente, { text: `🔐 Menú activado, jefe.\n\ninforme · apagar · encender · restaura · salir` }); return; }
        if (modoJefe.get(remitente)) { await procesarComandoJefe(sock, remitente, textoPersonal); return; }

        try { const manejado = await manejarComandosGenerales(sock, remitente, remitente, textoPersonal, [], false, remitente); if (manejado) return; } catch (err) { return; }

        if (debeResponderIA(textoPersonal, msg, IDENTIFICADORES_BOT_CACHE)) {
          const consultaSinMencion = textoPersonal.replace(/^\/\S*\s*/, '').trim() || textoPersonal;

          const audioCitado = extraerAudioCitado(msg);
          if (audioCitado) {
            try {
              const bufferAudio = await descargarAudioCitado(audioCitado);
              const respuesta = await generarRespuestaIAConAudio(bufferAudio, audioCitado.mimetype, consultaSinMencion || 'Escucha este audio y cuéntame de qué trata.', `Mensaje privado de ${msg.pushName || 'un usuario'}.`, remitente, remitente);
              await enviarRespuestaHumanizada(sock, remitente, respuesta, []);
              agregarAMemoriaCorta(remitente, textoPersonal, respuesta);
            } catch (err) { await sock.sendMessage(remitente, { text: '💔 No pude escuchar ese audio.' }); }
            return;
          }

          const nombreBuscado = detectarSolicitudInfoPorNombre(consultaSinMencion);
          if (nombreBuscado && esPropietarioEfectivo(remitente)) {
            const encontrados = buscarIntegrantesPorNombre(nombreBuscado);
            if (encontrados.length === 1) { await enviarFichaCompleta(sock, remitente, encontrados[0]); return; }
            if (encontrados.length > 1) { await sock.sendMessage(remitente, { text: `Varias coincidencias:\n\n${encontrados.map(f => `• ${f.nombre} (${f.apodo}) — código ${f.codigo}`).join('\n')}\n\nUsa /clan ver <código>.` }); return; }
          }
          try {
            const esDueño = esPropietarioEfectivo(remitente);
            let notas = `Mensaje privado de ${msg.pushName || 'un usuario'}.`;
            if (esDueño) notas += `\n\nIMPORTANTE: es TU PROPIETARIO/CREADOR.`;
            notas += obtenerContextoCorto(remitente);
            const respuesta = await generarRespuestaIA(consultaSinMencion, notas, remitente, remitente);
            await enviarRespuestaHumanizada(sock, remitente, respuesta, []);
            agregarAMemoriaCorta(remitente, textoPersonal, respuesta);
          } catch (err) { await sock.sendMessage(remitente, { text: mensajeEsperaAleatorio() }); }
        }
      }
      return;
    }

    if (!botActivo) return;
    const tipoMensaje = Object.keys(msg.message)[0];
    const tieneTexto = !!(msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption);
    const esSoloMedia = ['audioMessage', 'videoMessage', 'stickerMessage'].includes(tipoMensaje) && !tieneTexto;
    const esImagenSinTexto = tipoMensaje === 'imageMessage' && !tieneTexto;
    if (esSoloMedia || esImagenSinTexto) return;

    estado.mensajesRecibidos++;
    try { await procesarMensajeGrupo(sock, msg, IDENTIFICADORES_BOT_CACHE); estado.mensajesEnviados++; }
    catch (err) { console.log('❌ Error procesando mensaje de grupo:', err.message); }
  });
}

setInterval(async () => {
  if (!sockActivo || recordatoriosGrupo.length === 0) return;
  const ahora = Date.now();
  for (let i = recordatoriosGrupo.length - 1; i >= 0; i--) {
    if (recordatoriosGrupo[i].tiempoEjecucion <= ahora) { const r = recordatoriosGrupo[i]; try { await sockActivo.sendMessage(r.jidGrupo, { text: `⏰ Recordatorio: ${r.texto}` }); } catch (err) {} recordatoriosGrupo.splice(i, 1); }
  }
}, 30 * 1000);

const PANEL_FONDO_URL = limpiarValorEnv(process.env.PANEL_FONDO_URL) || '';

const LISTA_COMANDOS_PANEL = [
  { cat: '🧠 Inteligencia Artificial', items: [['/anzy <pregunta>', 'Pregúntale a la IA'], ['@bot <pregunta>', 'Mencionando al bot'], ['Cita un audio + menciona', 'Entiende y responde sobre el audio 🎙️'], ['/imagen <descripción>', 'Genera una imagen con IA']] },
  { cat: '🎭 Modos', items: [['/novia on · off', 'Modo cariñoso'], ['/amiga on · off', 'Modo amiga']] },
  { cat: '🎉 Descargas', items: [['/tiktok <enlace>', 'TikTok sin marca de agua'], ['/youtube <enlace>', 'Audio de YouTube'], ['/youtubevideo <enlace>', 'Video de YouTube'], ['/facebook <enlace>', 'Video de Facebook'], ['/facebookaudio <enlace>', 'Audio de Facebook'], ['/instagram <enlace>', 'Video de Instagram']] },
  { cat: '🎉 Utilidades', items: [['/frase', 'Frase random'], ['/perfil @user', 'Actividad en el grupo']] },
  { cat: '👑 Admin (grupo)', items: [['/promover @user', 'Lo hace admin'], ['/degradar @user', 'Le quita admin'], ['/todos <msj>', 'Etiqueta a todos'], ['/cerrar · /abrir', 'Controla quién escribe'], ['/recordatorio <n>S/M/H <texto>', 'Aviso al grupo'], ['/ranking', 'Top de más activas']] },
  { cat: '👑 SOLO PROPIETARIO (oculto del chat)', items: [
    ['/propietario', 'Verifica con contraseña (persiste en GitHub)'],
    ['/nombreff · /numeroff · /idff · /apodoff', 'Registro paso a paso'],
    ['/fotoff <código>', 'Guarda foto'], ['/eliminar foto <código>', 'Quita solo la foto'],
    ['/clan agregar/quitar/ver', 'Gestión del clan'], ['/eliminar <código>', 'Elimina integrante'],
    ['/integrantes · /lista NN', 'Ver el clan'], ['/integrante @user', 'Ficha de esa persona'],
    ['/silencio · /activarse @user', 'Ignorar/reactivar usuario'], ['/movimiento', 'Últimos movimientos'],
    ['/actualizacion <mejoras>', 'La IA redacta el aviso de mantenimiento y lo manda a todos los grupos'],
    ['Aviso de salida', 'Si un integrante sale del grupo, el aviso+ficha+foto se manda AL MISMO GRUPO; solo tú confirmas la eliminación']
  ] },
  { cat: '📋 Info', items: [['/info', 'Info del bot'], ['/creador', 'Quién lo hizo'], ['/comando anzy', 'Lista pública']] },
  { cat: '🗂️ Memoria', items: [['/recordar', 'Qué recuerda de ti'], ['/olvidarme', 'Borra su memoria']] }
];

function generarHtmlComandos() {
  return LISTA_COMANDOS_PANEL.map(grupo => `
    <div class="cat-titulo">${grupo.cat}</div>
    <div class="cmd-grid">${grupo.items.map(([nombre, desc]) => `<div class="cmd-card"><div class="cmd-nombre">${nombre}</div><div class="cmd-desc">${desc}</div></div>`).join('')}</div>
  `).join('');
}

const app = express();

app.get('/status', (req, res) => {
  res.json({ conectado: estado.conectado, botActivo, uptimeSegundos: Math.floor((Date.now() - estado.inicio) / 1000), mensajesRecibidos: estado.mensajesRecibidos, mensajesEnviados: estado.mensajesEnviados, intentosReconexion: estado.intentosReconexion, cuotaUsada: contadorCuota.usados, cuotaLimite: LIMITE_DIARIO_ESTIMADO, version: VERSION_BOT });
});

app.get('/panel/toggle', (req, res) => { botActivo = !botActivo; res.redirect('/'); });

app.get('/panel/actualizacion', async (req, res) => {
  if (sockActivo) {
    try {
      const anuncio = await generarAnuncioActualizacionIA(req.query.mejoras || '');
      const mensajeFinal = `${anuncio}\n\n_Versión actual: v${VERSION_BOT}_\n\n> ${CREADOR}`;
      const grupos = await sockActivo.groupFetchAllParticipating();
      for (const jid of Object.keys(grupos)) { try { await sockActivo.sendMessage(jid, { text: mensajeFinal }); } catch (err) {} }
    } catch (err) {}
  }
  res.redirect('/');
});

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>${NOMBRE_BOT} · Panel</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Creepster&family=Orbitron:wght@500;700;900&family=Space+Mono&display=swap" rel="stylesheet">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background-color: #0a0005;
    ${PANEL_FONDO_URL ? `background-image: linear-gradient(rgba(10,0,5,0.75), rgba(10,0,5,0.9)), url('${PANEL_FONDO_URL}'); background-size: cover; background-position: center; background-attachment: fixed;` : `background-image: radial-gradient(circle at 20% 0%, #2a0015 0%, #0a0005 55%, #000000 100%);`}
    color: #ffd6e8; font-family: 'Space Mono', monospace; min-height: 100vh; display: flex; flex-direction: column; align-items: center; padding: 50px 20px 70px; overflow-x: hidden; position: relative;
  }
  .blob { position: fixed; border-radius: 50%; filter: blur(100px); opacity: 0.35; z-index: 0; pointer-events: none; }
  .blob1 { width: 420px; height: 420px; background: #ff0044; top: -120px; left: -140px; animation: flotar1 10s ease-in-out infinite; }
  .blob2 { width: 360px; height: 360px; background: #6a0033; bottom: -100px; right: -120px; animation: flotar2 13s ease-in-out infinite; }
  @keyframes flotar1 { 0%,100% { transform: translate(0,0); } 50% { transform: translate(50px,70px); } }
  @keyframes flotar2 { 0%,100% { transform: translate(0,0); } 50% { transform: translate(-60px,-40px); } }
  .lazo { font-size: 50px; text-align: center; margin-bottom: -10px; filter: drop-shadow(0 0 10px #ff0044); animation: parpadeo 3s infinite; position: relative; z-index: 1; }
  @keyframes parpadeo { 0%,90%,100% { opacity: 1; } 95% { opacity: 0.2; } }
  h1 { font-family: 'Creepster', cursive; font-weight: 400; font-size: 56px; letter-spacing: 6px; color: #ff0044; text-align: center; position: relative; z-index: 1; text-shadow: 0 0 20px #ff0044, 0 0 40px #6a0033; animation: glitch 4s infinite; }
  @keyframes glitch { 0%,96%,100% { transform: translate(0,0); } 97% { transform: translate(-2px,1px); } 98% { transform: translate(2px,-1px); } 99% { transform: translate(-1px,0px); } }
  .goteo { width: 100%; max-width: 500px; height: 6px; background: repeating-linear-gradient(90deg, #ff0044 0 4px, transparent 4px 20px); margin: 10px 0 30px; position: relative; z-index: 1; }
  .sub { color: #d999b3; font-size: 12px; letter-spacing: 3px; margin-bottom: 34px; text-transform: uppercase; position: relative; z-index: 1; }
  .badge { padding: 10px 26px; border-radius: 30px; font-family: 'Orbitron', sans-serif; font-weight: 700; font-size: 13px; letter-spacing: 2px; display: flex; align-items: center; gap: 10px; margin-bottom: 20px; position: relative; z-index: 1; }
  .dot { width: 10px; height: 10px; border-radius: 50%; }
  .online { background: rgba(255,0,68,0.12); border: 1px solid #ff0044; color: #ff0044; }
  .online .dot { background: #ff0044; box-shadow: 0 0 10px #ff0044; animation: pulso 1.2s infinite; }
  .offline { background: rgba(100,100,100,0.12); border: 1px solid #555; color: #bbb; }
  .offline .dot { background: #666; }
  @keyframes pulso { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
  .controles { display: flex; gap: 12px; margin-bottom: 30px; position: relative; z-index: 1; flex-wrap: wrap; justify-content: center; }
  .btn-control { background: linear-gradient(160deg, #6a0033, #2a0015); border: 1px solid #ff0044; color: #ffd6e8; font-family: 'Orbitron', sans-serif; font-size: 11px; letter-spacing: 1px; padding: 10px 18px; border-radius: 8px; cursor: pointer; text-decoration: none; transition: box-shadow .2s, transform .2s; }
  .btn-control:hover { box-shadow: 0 0 18px #ff0044; transform: translateY(-2px); }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 16px; width: 100%; max-width: 900px; position: relative; z-index: 1; }
  .card { background: linear-gradient(160deg, rgba(60,0,25,0.85), rgba(10,0,5,0.9)); border: 1px solid rgba(255,0,68,0.35); border-radius: 14px; padding: 20px; text-align: center; box-shadow: 0 0 20px rgba(255,0,68,0.12); }
  .card .valor { font-family: 'Orbitron', sans-serif; font-size: 26px; color: #ffd6e8; font-weight: 700; }
  .card .etiqueta { font-size: 10px; color: #d999b3; margin-top: 8px; text-transform: uppercase; letter-spacing: 1.5px; }
  .seccion { margin-top: 40px; margin-bottom: 14px; font-family: 'Orbitron', sans-serif; font-size: 13px; letter-spacing: 3px; color: #ff0044; text-transform: uppercase; align-self: flex-start; max-width: 900px; width: 100%; position: relative; z-index: 1; text-shadow: 0 0 8px #ff0044; }
  .barra-fondo { width: 100%; max-width: 900px; height: 16px; background: rgba(255,255,255,0.06); border-radius: 10px; overflow: hidden; border: 1px solid rgba(255,0,68,0.3); position: relative; z-index: 1; }
  .barra-relleno { height: 100%; background: linear-gradient(90deg, #ff0044, #6a0033); box-shadow: 0 0 10px #ff0044; }
  .cat-titulo { font-family: 'Orbitron', sans-serif; font-size: 14px; letter-spacing: 2px; color: #ff6ea3; margin: 26px 0 12px; text-transform: uppercase; width: 100%; max-width: 900px; position: relative; z-index: 1; }
  .cmd-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; width: 100%; max-width: 900px; position: relative; z-index: 1; }
  .cmd-card { background: rgba(40,0,15,0.8); border: 1px solid rgba(255,0,68,0.25); border-radius: 10px; padding: 12px 16px; transition: border-color .2s, box-shadow .2s; }
  .cmd-card:hover { border-color: #ff0044; box-shadow: 0 0 16px rgba(255,0,68,0.3); }
  .cmd-nombre { font-family: 'Orbitron', sans-serif; font-size: 12px; color: #ff6ea3; letter-spacing: 1px; }
  .cmd-desc { font-size: 11px; color: #d999b3; margin-top: 4px; }
  #qr { margin-top: 30px; position: relative; z-index: 1; }
  #qr img { border-radius: 14px; border: 2px solid rgba(255,0,68,0.4); box-shadow: 0 0 30px rgba(255,0,68,0.3); }
</style>
</head>
<body>
  <div class="blob blob1"></div>
  <div class="blob blob2"></div>
  <div class="lazo">🎀💀</div>
  <h1>${NOMBRE_BOT.toUpperCase()}</h1>
  <div class="goteo"></div>
  <div class="sub">Panel de control tenebroso · ${CREADOR}</div>
  <div id="badge" class="badge offline"><div class="dot"></div>Cargando...</div>
  <div class="controles">
    <a href="/panel/toggle" class="btn-control">⚡ Encender / Apagar bot</a>
    <a href="/panel/actualizacion" class="btn-control">🛠️ Avisar actualización</a>
  </div>
  <div class="seccion">Actividad</div>
  <div class="grid">
    <div class="card"><div class="valor" id="msgIn">0</div><div class="etiqueta">Recibidos</div></div>
    <div class="card"><div class="valor" id="msgOut">0</div><div class="etiqueta">Enviados</div></div>
    <div class="card"><div class="valor" id="uptime">0s</div><div class="etiqueta">Uptime</div></div>
    <div class="card"><div class="valor" id="reint">0</div><div class="etiqueta">Reconexiones</div></div>
  </div>
  <div class="seccion">Cuota de IA hoy</div>
  <div class="grid"><div class="card" style="grid-column: 1 / -1"><div class="valor" id="cuotaTexto">0 / 0</div><div class="barra-fondo" style="margin-top:14px"><div class="barra-relleno" id="cuotaBarra" style="width:0%"></div></div></div></div>
  <div class="seccion" style="margin-top:50px">Comandos disponibles</div>
  ${generarHtmlComandos()}
  <div id="qr"></div>
  <script>
    async function actualizar() {
      const r = await fetch('/status'); const d = await r.json();
      const badge = document.getElementById('badge');
      badge.innerHTML = '<div class="dot"></div>' + (d.conectado ? (d.botActivo ? 'CONECTADO' : 'CONECTADO (bot apagado)') : 'DESCONECTADO') + ' · v' + d.version;
      badge.className = 'badge ' + (d.conectado ? 'online' : 'offline');
      document.getElementById('msgIn').textContent = d.mensajesRecibidos;
      document.getElementById('msgOut').textContent = d.mensajesEnviados;
      document.getElementById('reint').textContent = d.intentosReconexion;
      const h = Math.floor(d.uptimeSegundos / 3600), m = Math.floor((d.uptimeSegundos % 3600) / 60), s = d.uptimeSegundos % 60;
      document.getElementById('uptime').textContent = h + 'h ' + m + 'm ' + s + 's';
      document.getElementById('cuotaTexto').textContent = d.cuotaUsada + ' / ' + d.cuotaLimite;
      document.getElementById('cuotaBarra').style.width = Math.min(100, Math.round((d.cuotaUsada / d.cuotaLimite) * 100)) + '%';
    }
    setInterval(actualizar, 3000);
    actualizar();
  </script>
</body>
</html>`);
});

app.get('/qr', (req, res) => {
  if (!estado.ultimoQR) return res.send('<h2 style="font-family:sans-serif;color:#fff;background:#000;height:100vh;display:flex;align-items:center;justify-content:center">No hay QR pendiente.</h2>');
  res.send(`<body style="background:#000;display:flex;justify-content:center;align-items:center;height:100vh"><img src="${estado.ultimoQR}" /></body>`);
});

app.listen(PUERTO, () => console.log(`🌐 Panel web activo en el puerto ${PUERTO}`));

const URL_PROPIA = process.env.RENDER_EXTERNAL_URL;
if (URL_PROPIA) setInterval(() => { fetch(URL_PROPIA).catch(() => {}); }, 4 * 60 * 1000);

iniciarBot();
