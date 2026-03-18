require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const docx = require('docx');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const googleTTS = require('google-tts-api');
const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, ExternalHyperlink } = docx;

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

// Inicializamos Gemini API
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

async function callAgent(agentFileName, promptText, retries = 3) {
    if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY no está configurada en el archivo .env");
    const skillPath = path.join(__dirname, 'Skills', agentFileName);
    const systemInstruction = fs.existsSync(skillPath) ? fs.readFileSync(skillPath, 'utf8') : '';

    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash", systemInstruction });

    try {
        const result = await model.generateContent(promptText);
        return result.response.text();
    } catch (error) {
        const isRateLimit = error.status === 429 || (error.message && error.message.includes('429'));
        if (isRateLimit && retries > 0) {
            console.log(`[Reintento] Límite de cuota (429) alcanzado en ${agentFileName}. Esperando 15s... (Retries: ${retries})`);
            await new Promise(res => setTimeout(res, 15000));
            return callAgent(agentFileName, promptText, retries - 1);
        }
        throw error;
    }
}

// Función para generar audio MP3 desde texto (soporta textos largos)
async function generateAudio(text, outputPath) {
    // google-tts-api tiene límite de 200 chars por request, getAllAudioUrls lo divide automáticamente
    const urls = googleTTS.getAllAudioUrls(text, {
        lang: 'en',
        slow: false,
        host: 'https://translate.google.com',
    });

    // Descargamos cada segmento y los concatenamos en un solo MP3
    const buffers = [];
    for (const urlObj of urls) {
        const response = await fetch(urlObj.url);
        const arrayBuffer = await response.arrayBuffer();
        buffers.push(Buffer.from(arrayBuffer));
    }
    const finalBuffer = Buffer.concat(buffers);
    fs.writeFileSync(outputPath, finalBuffer);
    return outputPath;
}

// Función para extraer el texto de Reading Comprehension de la guía generada
function extractReadingText(fullText) {
    // Buscamos patrones como "Reading section", "Reading Comprehension", "READING", o después de una historia en inglés
    const patterns = [
        /(?:Reading\s*(?:section|comprehension)?[.:\s]*\n?)([\s\S]*?)(?=\n\s*(?:Comprehension|True|False|Questions|[A-Z]\.\s|LISTENING|$))/i,
        /(?:LECTURA|READING)[.:\s]*\n([\s\S]*?)(?=\n\s*(?:COMPREHENSION|QUESTIONS|TRUE|[A-Z]\.))/i,
    ];

    for (const pattern of patterns) {
        const match = fullText.match(pattern);
        if (match && match[1] && match[1].trim().length > 50) {
            return match[1].trim();
        }
    }

    // Fallback: si no encontramos el patrón, buscamos el bloque de texto en inglés más largo
    const lines = fullText.split('\n');
    let longestBlock = '';
    let currentBlock = '';

    for (const line of lines) {
        if (line.trim().length > 20 && /^[A-Za-z\s,.'!?;:\-"]+$/.test(line.trim())) {
            currentBlock += line.trim() + ' ';
        } else {
            if (currentBlock.length > longestBlock.length) {
                longestBlock = currentBlock;
            }
            currentBlock = '';
        }
    }
    if (currentBlock.length > longestBlock.length) longestBlock = currentBlock;

    return longestBlock.trim() || fullText.substring(0, 500);
}

// Ruta del escritorio
function getDesktopPath() {
    const escritorio = path.join(os.homedir(), 'OneDrive', 'Escritorio');
    return fs.existsSync(escritorio) ? escritorio : path.join(os.homedir(), 'Desktop');
}

// ====== ENDPOINTS ======

app.post('/api/buscador', async (req, res) => {
    try {
        const respuesta = await callAgent('buscador.md', `Tema/Intención: ${req.body.prompt}`);
        res.json({ status: 'success', data: respuesta });
    } catch (e) { res.status(500).json({ status: 'error', data: e.message }); }
});

app.post('/api/creador', async (req, res) => {
    try {
        const respuesta = await callAgent('creador.md', `Con base en la búsqueda anterior:\n${req.body.prompt}`);
        res.json({ status: 'success', data: respuesta });
    } catch (e) { res.status(500).json({ status: 'error', data: e.message }); }
});

app.post('/api/generador', async (req, res) => {
    try {
        const respuesta = await callAgent('generador notebook.md', `Crea actividades basándote en este contexto:\n${req.body.prompt}`);
        res.json({ status: 'success', data: respuesta });
    } catch (e) { res.status(500).json({ status: 'error', data: e.message }); }
});

app.post('/api/disenador', async (req, res) => {
    try {
        console.log('[Disenador] Iniciando generación del documento Word...');
        console.log('[Disenador] Input recibido:', req.body.prompt.substring(0, 100) + '...');

        const contenidoFinal = await callAgent('Diseñador.md', `Adapta el siguiente contenido al formato final institucional:\n${req.body.prompt}`);

        console.log('[Disenador] Contenido generado por IA:', contenidoFinal.substring(0, 200) + '...');

        // Nombre base para archivos (Word y MP3 comparten nombre)
        const timestamp = Date.now();
        const baseName = `Guia_de_Estudio_${timestamp}`;
        const desktopPath = getDesktopPath();
        const wordPath = path.join(desktopPath, `${baseName}.docx`);
        const audioPath = path.join(desktopPath, `${baseName}_Listening.mp3`);

        console.log('[Disenador] Ruta del escritorio:', desktopPath);
        console.log('[Disenador] Ruta del Word:', wordPath);

        // Extraer texto de Reading Comprehension y generar audio
        let audioGenerated = false;
        let audioFileName = `${baseName}_Listening.mp3`;
        try {
            const readingText = extractReadingText(contenidoFinal);
            if (readingText.length > 30) {
                await generateAudio(readingText, audioPath);
                audioGenerated = true;
                console.log(`Audio MP3 generado: ${audioPath}`);
            } else {
                console.log('[Disenador] Texto de lectura muy corto, omitiendo audio');
            }
        } catch (audioErr) {
            console.error("Error generando audio (continuando sin él):", audioErr.message);
        }

        // Construir el documento Word
        const docChildren = [
            new Paragraph({ text: "C.E.P. Rigoberto Fontt Izquierdo", heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER }),
            new Paragraph({ children: [new TextRun({ text: "Idioma Extranjero Inglés.", size: 24 })], alignment: AlignmentType.CENTER, spacing: { after: 100 } }),
            new Paragraph({ children: [new TextRun({ text: "Prof. Jaime Landa.", size: 24 })], alignment: AlignmentType.CENTER, spacing: { after: 200 } }),
        ];

        // Insertar cada línea del contenido
        for (const line of contenidoFinal.split('\n')) {
            // Si la línea contiene el marcador de audio, reemplazarlo con referencia al MP3
            if (line.includes('[Insertar Audio MP3 aquí]') && audioGenerated) {
                docChildren.push(new Paragraph({
                    children: [
                        new TextRun({ text: "AUDIO LISTENING: ", bold: true, size: 24 }),
                        new TextRun({ text: `Reproducir archivo adjunto: ${audioFileName}`, size: 24, italics: true }),
                    ],
                    spacing: { line: 240 },
                }));
            } else {
                // Detectar si es un título (línea en mayúsculas o empieza con letra + punto)
                const isTitleLine = /^[A-Z]\.\s/.test(line.trim()) || line.trim() === line.trim().toUpperCase() && line.trim().length > 3;
                docChildren.push(new Paragraph({
                    children: [new TextRun({
                        text: line,
                        size: isTitleLine ? 28 : 24,
                        bold: isTitleLine,
                    })],
                    spacing: { line: 240 },
                }));
            }
        }

        // Si se generó audio, agregar nota final en el documento
        if (audioGenerated) {
            docChildren.push(new Paragraph({ children: [], spacing: { before: 400 } }));
            docChildren.push(new Paragraph({
                children: [
                    new TextRun({ text: "NOTA: El archivo de audio para la sección Listening se encuentra en la misma carpeta que este documento.", bold: true, size: 22 }),
                ],
            }));
            docChildren.push(new Paragraph({
                children: [
                    new TextRun({ text: `Nombre del archivo: ${audioFileName}`, size: 22, italics: true }),
                ],
            }));
        }

        const doc = new Document({
            creator: "Planificador de Agentes",
            title: "Guía de Estudio",
            sections: [{ properties: {}, children: docChildren }],
        });

        const buffer = await Packer.toBuffer(doc);
        fs.writeFileSync(wordPath, buffer);

        console.log(`[Disenador] Word exportado exitosamente: ${wordPath}`);

        let mensaje = `Documento Word exportado: ${wordPath}`;
        if (audioGenerated) mensaje += `\nAudio MP3 Listening generado: ${audioPath}`;
        mensaje += `\n\nResumen:\n${contenidoFinal.substring(0, 300)}...`;

        res.json({ status: 'success', data: mensaje });
    } catch (e) {
        console.error('[Disenador] ERROR:', e.message);
        res.status(500).json({ status: 'error', data: e.message });
    }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'app.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor Backend Activo en http://localhost:${PORT}`));
