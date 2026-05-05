/**
 * RENTIFY CORE LOGIC SHOWCASE
 * Данный файл содержит ключевые модули десктоп-клиента:
 * 1. Глобальный перехватчик IPC (Event-driven logging)
 * 2. Сложная бизнес-логика аренды (Транзакции + умный пересчет долга)
 * 3. Интеграция с OCR Google Vision
 * 4. Интеграция с сервисом ЭЦП Sigex
 */

const { ipcMain, net, BrowserWindow } = require('electron');
const vision = require('@google-cloud/vision');

// ==========================================================================
// 1. GLOBAL IPC INTERCEPTOR (Аудит действий пользователя)
// ==========================================================================

const _originalHandle = ipcMain.handle.bind(ipcMain);

/**
 * Переопределение стандартного хендлера для автоматического логирования
 * всех бизнес-операций в локальную базу данных.
 */
ipcMain.handle = (channel, listener) => {
    _originalHandle(channel, async (event, ...args) => {
        try {
            const result = await listener(event, ...args);
            const logData = parseActionForLog(channel, args[0]);

            if (logData && db) {
                db.run(
                    "INSERT INTO action_logs (action, details) VALUES (?, ?)",
                    [logData.action, logData.details]
                );
            }
            return result;
        } catch (e) {
            console.error(`[IPC ERROR] Channel ${channel}:`, e);
            return { error: e.message };
        }
    });
};

function parseActionForLog(channel, data) {
    if (!data) return null;
    const actions = {
        'add-rent': { action: 'Создана аренда', details: `Сумма: ${data.total_price} ₸` },
        'complete-rent': { action: 'Аренда завершена', details: `Сделка #${data}` },
        'refund-payment': { action: 'Возврат средств', details: `Сумма: ${data.amount} ₸` },
        'activate-rent': { action: 'Выдача брони', details: `Сделка #${data} переведена в актив` }
    };
    return actions[channel] || null;
}

// ==========================================================================
// 2. BUSINESS LOGIC: RENT MANAGEMENT (Транзакции и расчеты)
// ==========================================================================

ipcMain.handle('add-rent', async (event, data) => {
    const run = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function(e) { e ? rej(e) : res(this); }));
    
    try {
        await run("BEGIN TRANSACTION");

        const itemsSum = data.items.reduce((acc, item) => acc + (item.price * item.count), 0);
        const consSum = (data.consumables || []).reduce((acc, c) => acc + (parseFloat(c.sale_price || 0) * c.quantity), 0);
        const totalAmount = itemsSum + consSum;
        const paidAmount = (data.payments || []).reduce((acc, p) => acc + p.amount, 0);

        // Создание основной записи аренды
        const resRent = await run(
            "INSERT INTO rents (client_id, status, date_start, date_end, total_price, paid_amount, total_consumables_price) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [data.client_id, data.status, data.start, data.end, totalAmount, paidAmount, consSum]
        );
        const rentID = resRent.lastID;

        // Сохранение позиций оборудования с привязкой конкретных инвентарных ID
        for (const item of data.items) {
            await run(
                "INSERT INTO rent_items (rent_id, catalog_id, tariff_id, tariff_price, inventory_ids, final_price) VALUES (?, ?, ?, ?, ?, ?)", 
                [rentID, item.id, item.tariff_id, item.price, String(item.inventory_id), item.final_price || item.price]
            );

            // Физическое списание со склада (если не просто бронь)
            if (data.status !== 'booked') {
                await run("UPDATE inventory SET status = 'rented' WHERE id = ?", [item.inventory_id]);
            }
        }

        // Обновление баланса клиента
        const debt = Math.max(0, totalAmount - paidAmount);
        await run("UPDATE clients SET rent_count = rent_count + 1, debt_amount = ROUND(debt_amount + ?, 2) WHERE id = ?", [debt, data.client_id]);
        
        await run("COMMIT");
        return { id: rentID };
    } catch (err) { 
        await run("ROLLBACK"); 
        throw err; 
    }
});

// ==========================================================================
// 3. INTEGRATION: OCR DOCUMENT RECOGNITION (Google Vision)
// ==========================================================================

ipcMain.handle('recognize-document', async (event, base64Image) => {
    try {
        const keyRow = await new Promise((res) => db.get("SELECT value FROM app_settings WHERE key = 'google_vision_key'", (err, row) => res(row)));
        if (!keyRow?.value) throw new Error("API credentials not found");

        const client = new vision.ImageAnnotatorClient({ credentials: JSON.parse(keyRow.value) });
        const base64Data = base64Image.replace(/^data:image\/\w+;base64,/, "");

        const [result] = await client.documentTextDetection(Buffer.from(base64Data, 'base64'));
        const fullText = result.fullTextAnnotation?.text || '';

        if (!fullText) throw new Error("No text detected");

        // Умный парсинг данных удостоверения личности (РК)
        const data = {
            iin: (fullText.match(/\b\d{12}\b/) || [''])[0],
            docNum: (fullText.match(/\b\d{9}\b/) || [''])[0]
        };

        // Извлечение дат (Birth, Issue, Expiry)
        const dates = fullText.match(/\b\d{2}\.\d{2}\.\d{4}\b/g) || [];
        if (dates.length >= 3) {
            const sorted = dates.map(d => ({ str: d, val: new Date(d.split('.').reverse().join('-')).getTime() })).sort((a,b) => a.val - b.val);
            data.birthDate = sorted[0].str;
            data.dateIssue = sorted[1].str;
            data.dateExpiry = sorted[2].str;
        }

        return { success: true, data };
    } catch (err) {
        return { error: err.message };
    }
});

// ==========================================================================
// 4. INTEGRATION: SIGEX E-SIGNATURE (Online signing flow)
// ==========================================================================

ipcMain.handle('sigex-create-sign-request', async (event, data) => {
    try {
        // 1. Создание сессии в Sigex
        const sessionResponse = await sigexRequest('https://sigex.kz/api/egovQr', 'POST', {
            description: `Договор аренды #${data.rent_id}`
        });

        // 2. Генерация PDF в фоновом окне Electron
        const pdfWin = new BrowserWindow({ show: false });
        await pdfWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(data.html_content)}`);
        const pdfBuffer = await pdfWin.webContents.printToPDF({ pageSize: 'A4' });
        pdfWin.close();

        // 3. Передача документа на сервер через цикл ожидания (Polling/Wait-flow)
        // Sigex требует, чтобы файл был передан после того, как клиент отсканирует QR
        initiateBackgroundUpload(sessionResponse.dataURL, pdfBuffer.toString('base64'));

        return {
            signId: sessionResponse.signURL,
            qrCodeBase64: `data:image/png;base64,${sessionResponse.qrCode}`
        };
    } catch (e) {
        return { error: e.message };
    }
});

async function sigexRequest(url, method, payload) {
    const creds = await getSigexCredentials(); // Получение IS_ID и API_KEY из БД
    const response = await fetch(url, {
        method,
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Basic ' + Buffer.from(`${creds.is_id}:${creds.api_key}`).toString('base64')
        },
        body: JSON.stringify(payload)
    });
    return response.json();
}
