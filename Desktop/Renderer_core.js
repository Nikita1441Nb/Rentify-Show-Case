/**
 * RENTIFY RENDERER CORE SHOWCASE
 * В данном файле собраны ключевые модули фронтенд-логики:
 * 1. Интеграция с eGov (Реестр должников)
 * 2. Обработка изображений (Stitching для OCR)
 * 3. Ядро расчетов (Recalculation Engine)
 * 4. Динамическая генерация документов на основе шаблонов
 */

// ==========================================================================
// 1. CLIENT INTELLIGENCE: eGov & Debt Validation
// ==========================================================================

/**
 * Проверка клиента по государственному реестру должников.
 * Демонстрирует работу с внешними API, обработку сетевых состояний 
 * и динамическое управление UI-компонентами (tooltips/badges).
 */
const checkEgovDebt = async (iin, inputEl, badgeContainer) => {
    if (!iin || iin.length !== 12 || !navigator.onLine) return;
    
    badgeContainer.innerHTML = '<i class="ti ti-loader ti-spin"></i>';

    try {
        const res = await window.api.invoke('check-egov-debt', iin);
        
        if (res.hasDebt) {
            // Визуальная индикация риска
            badgeContainer.innerHTML = `
                <div class="egov-alert-trigger">
                    <i class="ti ti-shield-x" style="color: #ef4444;"></i>
                    <div class="egov-tooltip">
                        <strong>В реестре должников!</strong>
                        <p>Найдено исполнительных производств: ${res.count}</p>
                        <button onclick="openAdilet('${iin}')">Проверить на сайте МЮ РК</button>
                    </div>
                </div>`;
        } else {
            badgeContainer.innerHTML = '<i class="ti ti-shield-check" style="color: #10b981;"></i>';
        }
    } catch (err) {
        badgeContainer.innerHTML = '<i class="ti ti-wifi-off"></i>';
    }
};

// ==========================================================================
// 2. IMAGE PROCESSING: Document Stitching for OCR
// ==========================================================================

/**
 * Склейка лицевой и оборотной стороны удостоверения личности на Canvas.
 * Позволяет отправить в Google Vision API один оптимизированный файл вместо двух.
 */
const stitchImages = (base64Front, base64Back) => {
    return new Promise((resolve, reject) => {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        const img1 = new Image();
        const img2 = new Image();

        let loaded = 0;
        const onload = () => {
            loaded++;
            if (loaded === 2) {
                const width = Math.max(img1.width, img2.width);
                canvas.width = width;
                canvas.height = img1.height + img2.height;
                
                ctx.fillStyle = "white";
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                ctx.drawImage(img1, 0, 0);
                ctx.drawImage(img2, 0, img1.height);
                
                resolve(canvas.toDataURL('image/jpeg', 0.8));
            }
        };

        img1.onload = onload; img2.onload = onload;
        img1.src = base64Front; img2.src = base64Back;
    });
};

// ==========================================================================
// 3. CORE CALCULATION ENGINE: Rental Math
// ==========================================================================

/**
 * Динамический пересчет стоимости всей корзины.
 * Учитывает выбранные тарифы (сутки/часы), кратность периода, 
 * индивидуальные и процентные скидки для каждой позиции.
 */
const recalcTotal = () => {
    const start = new Date(document.querySelector('[name="rent_start"]').value);
    const end = new Date(document.querySelector('[name="rent_end"]').value);
    let total = 0;

    if (end > start) {
        const rentTotalHours = Math.ceil((end - start) / (1000 * 60 * 60));
        
        RentModule.cache.cart.forEach(item => {
            if (item.status === 'cancelled') return;

            const tariff = item.selectedTariff;
            const tDuration = (tariff.duration_days * 24) + (tariff.duration_hours || 0);
            const multiplier = Math.ceil(rentTotalHours / (tDuration || 24));
            
            const basePrice = tariff.price * multiplier;
            
            // Динамический расчет скидки, если она задана в процентах
            if (item.discount_percent > 0) {
                item.discount = Math.round(basePrice * (item.discount_percent / 100));
            }

            total += Math.max(0, basePrice - (item.discount || 0));
        });
    }
    
    // Добавление стоимости расходных материалов (продажа)
    RentModule.cache.consumablesCart.forEach(c => {
        total += (parseFloat(c.sale_price) * c.quantity);
    });

    updateUI(total);
};

// ==========================================================================
// 4. DOCUMENT GENERATION: Template Parsing
// ==========================================================================

/**
 * Генерация HTML-документа для печати или подписи.
 * Заменяет переменные (tokens) в шаблоне на реальные данные сделки, 
 * включая генерацию сложных таблиц оборудования "на лету".
 */
const generateDocumentHtml = async (rent, templateId) => {
    const template = cache.templates.find(t => t.id == templateId);
    let html = template.content;

    // Генерация таблицы оборудования
    let tableHtml = `<table class="doc-table">
        <thead><tr><th>Артикул</th><th>Наименование</th><th>Цена</th></tr></thead>
        <tbody>`;
    
    rent.items.forEach(item => {
        tableHtml += `<tr>
            <td>${item.inventory_article}</td>
            <td>${item.title}</td>
            <td>${item.final_price} ₸</td>
        </tr>`;
    });
    tableHtml += `</tbody></table>`;

    // Словарь подстановок
    const dict = {
        '{{client_name}}': rent.client_name,
        '{{rent_id}}': rent.id || 'НОВАЯ',
        '{{total_price}}': `${rent.total_price} ₸`,
        '{{table_products}}': tableHtml,
        '{{current_date}}': new Date().toLocaleDateString('ru-RU')
    };

    // Массовая замена через регулярные выражения
    Object.entries(dict).forEach(([key, val]) => {
        html = html.split(key).join(String(val));
    });

    return html;
};
