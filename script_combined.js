/**
 * Chronic Illness Guardian - Combined Script
 * Refactored Version: Organized, De-duplicated, and Optimized
 */

// ==========================================
// 1. 全域變數與設定 (Global Variables)
// ==========================================
let bpRecords = [];
let bsRecords = [];
let medRecords = []; // 藥物紀錄
let currentPatient = {}; // FHIR 患者資源
let tesseractWorker = null; // OCR Worker
let bpChartInstance = null;
let bsChartInstance = null;
let medChartInstance = null; // 藥物趨勢圖表
let qrcode = null;
let currentFontSizeScale = 1.0;

// 藥物資料庫 (模擬資料)
const drugDatabase = [
    { id: "d01", category: "diabetes", name: "美獲平 (Metformin)", sideEffect: "常見副作用：腸胃不適、腹瀉。請隨餐服用。", interactions: ["depression"] },
    { id: "d02", category: "diabetes", name: "愛妥糖 (Pioglitazone)", sideEffect: "可能導致水腫或體重增加。", interactions: [] },
    { id: "d03", category: "diabetes", name: "佳糖維 (Januvia)", sideEffect: "副作用較少，偶有鼻咽炎。", interactions: [] },
    { id: "m01", category: "depression", name: "百憂解 (Fluoxetine)", sideEffect: "可能導致失眠或食慾改變。", interactions: ["diabetes"] },
    { id: "m02", category: "depression", name: "立普能 (Escitalopram)", sideEffect: "初期可能會有噁心感。", interactions: [] },
    { id: "m03", category: "depression", name: "千憂解 (Cymbalta)", sideEffect: "可能影響血壓，需定期量測。", interactions: ["hypertension"] },
    { id: "h01", category: "hypertension", name: "脈優 (Amlodipine)", sideEffect: "可能導致下肢水腫或臉部潮紅。", interactions: [] },
    { id: "h02", category: "hypertension", name: "可悅您 (Cozaar)", sideEffect: "偶有暈眩，起身請緩慢。", interactions: [] }
];

// ==========================================
// 2. 資料存取層 (Local Storage Handling)
// ==========================================

// 載入所有數據
function loadAllData() {
    try {
        // 血壓記錄
        const storedBp = localStorage.getItem('bpRecords');
        if (storedBp) {
            const loadedBp = JSON.parse(storedBp);
            // 相容性處理舊資料
            bpRecords = loadedBp.map(r => ({
                date: r.dateTime ? new Date(r.dateTime).toISOString() : r.date,
                systolic: r.systolic,
                diastolic: r.diastolic,
                pulse: r.pulse,
                medication: r.medicationTaken || r.medication || false,
                armPosition: r.armPosition || 'N/A'
            }));
        }

        // 血糖記錄
        const storedBs = localStorage.getItem('bsRecords');
        if (storedBs) {
            const loadedBs = JSON.parse(storedBs);
            bsRecords = loadedBs.map(r => ({
                date: r.dateTime ? new Date(r.dateTime).toISOString() : r.date,
                value: r.value,
                unit: 'mg/dL',
                timing: r.measurementTime || r.timing,
                medication: r.medicationTaken || r.medication || false
            }));
        }

        // 藥物記錄
        const storedMed = localStorage.getItem('medRecords');
        if (storedMed) {
            medRecords = JSON.parse(storedMed);
        }

    } catch (e) {
        console.error('Error loading records:', e);
        bpRecords = []; bsRecords = []; medRecords = [];
    }
}

// 儲存血壓/血糖
function saveRecords() {
    try {
        localStorage.setItem('bpRecords', JSON.stringify(bpRecords));
        localStorage.setItem('bsRecords', JSON.stringify(bsRecords));
    } catch (e) {
        console.error('Error saving vital records:', e);
    }
}

// 儲存藥物紀錄
function saveMedRecords() {
    try {
        localStorage.setItem('medRecords', JSON.stringify(medRecords));
    } catch (e) {
        console.error('Error saving medication records:', e);
    }
}

// ==========================================
// 3. 患者管理 (Patient Management)
// ==========================================
function createDefaultPatient() {
    return {
        resourceType: "Patient",
        id: crypto.randomUUID(),
        meta: { lastUpdated: new Date().toISOString() },
        text: { status: "generated", div: "<div xmlns=\"http://www.w3.org/1999/xhtml\">默認患者資料</div>" },
        identifier: [{ use: "usual", type: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v2-0203", code: "MR", display: "Medical Record Number" }] }, system: "urn:oid:1.2.36.1.4.1.30008.2.1.1.1", value: "未設定-1" }],
        name: [{ use: "usual", text: "未設定姓名" }],
        gender: "unknown",
        birthDate: "1900-01-01"
    };
}

function initializePatient() {
    const storedPatient = localStorage.getItem('fhirPatient');
    if (storedPatient) {
        try {
            currentPatient = JSON.parse(storedPatient);
            // 確保資料結構完整
            if (!currentPatient.name) currentPatient.name = [{ use: "usual", text: "未設定姓名" }];
            if (!currentPatient.identifier) currentPatient.identifier = [{ use: "usual", value: currentPatient.id || "未設定-1" }];
        } catch (e) {
            currentPatient = createDefaultPatient();
        }
    } else {
        currentPatient = createDefaultPatient();
        localStorage.setItem('fhirPatient', JSON.stringify(currentPatient));
    }
}

function updatePatientDisplay() {
    const patientName = currentPatient.name?.[0]?.text || '未設定姓名';
    const patientId = currentPatient.identifier?.[0]?.value || '無 ID';
    const patientGender = getGenderDisplay(currentPatient.gender);
    const birthYear = parseInt((currentPatient.birthDate || '1900').substring(0, 4));
    const age = new Date().getFullYear() - birthYear;

    document.getElementById('patient-name').textContent = patientName;
    document.getElementById('patient-id').textContent = patientId;
    document.getElementById('patient-gender-display').textContent = patientGender;
    document.getElementById('patient-age').textContent = age > 0 ? age : 'N/A';
}

function savePatientInfo(event) {
    event.preventDefault();
    const name = document.getElementById('patient-name-input').value.trim();
    const birthYear = document.getElementById('patient-birth-year-input').value.trim();
    const gender = document.getElementById('patient-gender-input').value;
    const id = document.getElementById('patient-id-input').value.trim();

    if (!name || !birthYear || !id || gender === 'unknown') {
        return Swal.fire('錯誤', '請填寫完整資訊', 'error');
    }

    currentPatient.name[0].text = name;
    currentPatient.birthDate = birthYear + "-01-01";
    currentPatient.gender = gender;
    currentPatient.id = id;
    if (!currentPatient.identifier) currentPatient.identifier = [{ use: "usual", value: id }];
    else currentPatient.identifier[0].value = id;
    currentPatient.meta.lastUpdated = new Date().toISOString();

    // 更新並重置
    localStorage.setItem('fhirPatient', JSON.stringify(currentPatient));
    bpRecords = []; bsRecords = []; // 重置舊紀錄
    saveRecords();
    
    updatePatientDisplay();
    updateHistoryTables();
    updateLatestRecords();
    
    Swal.fire('成功', '患者資訊已更新，歷史記錄已重置', 'success').then(() => {
        const modal = bootstrap.Modal.getInstance(document.getElementById('patientModal'));
        if(modal) modal.hide();
    });
}

function populatePatientForm() {
    if (currentPatient.name?.[0]) document.getElementById('patient-name-input').value = currentPatient.name[0].text;
    if (currentPatient.identifier?.[0]) document.getElementById('patient-id-input').value = currentPatient.identifier[0].value;
    if (currentPatient.birthDate) document.getElementById('patient-birth-year-input').value = currentPatient.birthDate.substring(0, 4);
    if (currentPatient.gender) document.getElementById('patient-gender-input').value = currentPatient.gender;
}

// ==========================================
// 4. 輔助功能與格式化 (Helpers & Formatters)
// ==========================================
function adjustFontSize(factor) {
    if (factor > 1) currentFontSizeScale += 0.1;
    else {
        currentFontSizeScale -= 0.1;
        if (currentFontSizeScale < 0.8) currentFontSizeScale = 0.8;
    }
    const newSize = Math.round(18 * currentFontSizeScale);
    document.body.style.fontSize = newSize + 'px';
    document.querySelectorAll('table').forEach(t => t.style.fontSize = newSize + 'px');
}

function formatDateTime(isoString) {
    if (!isoString) return '--';
    const date = new Date(isoString);
    return `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function getGenderDisplay(gender) {
    const map = { 'male': '男性', 'female': '女性', 'other': '其他' };
    return map[gender] || '未知';
}

function getMeasurementTimeText(time) {
    const map = { 'fasting': '空腹', 'before-meal': '飯前', 'post-prandial': '飯後', 'before-sleep': '睡前' };
    return map[time] || time;
}

function getBpStatus(sys, dia) {
    if (sys < 90 || dia < 60) return { text: '低', class: 'primary', icon: 'fas fa-info-circle' };
    if (sys >= 140 || dia >= 90) return { text: '高', class: 'danger', icon: 'fas fa-exclamation-triangle' };
    if (sys >= 130 || dia >= 80) return { text: '偏高', class: 'warning', icon: 'fas fa-exclamation-circle' };
    if (sys >= 120) return { text: '偏高', class: 'warning', icon: 'fas fa-exclamation-circle' };
    return { text: '正常', class: 'normal', icon: 'fas fa-check-circle' };
}

function getBsStatus(value, timing) {
    if (value < 70) return { text: '偏低', class: 'warning', icon: 'fas fa-arrow-down' };
    
    let isHigh = false;
    let isWarning = false;

    if (timing === 'fasting') {
        if (value >= 126) isHigh = true;
        else if (value >= 100) isWarning = true;
    } else if (timing === 'post-prandial') {
        if (value >= 200) isHigh = true;
        else if (value >= 140) isWarning = true;
    } else {
        if (value >= 200) isHigh = true;
        else if (value >= 180) isWarning = true;
    }

    if (isHigh) return { text: '過高', class: 'danger', icon: 'fas fa-exclamation-triangle' };
    if (isWarning) return { text: '偏高', class: 'warning', icon: 'fas fa-exclamation-circle' };
    return { text: '正常', class: 'normal', icon: 'fas fa-check-circle' };
}

// ==========================================
// 5. FHIR 核心邏輯 (FHIR Core)
// ==========================================
function createBpObservation(record, patientUUID) {
    return {
        resourceType: "Observation",
        id: crypto.randomUUID(),
        status: "final",
        category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "vital-signs" }] }],
        code: { coding: [{ system: "http://loinc.org", code: "85354-9", display: "Blood pressure panel" }] },
        subject: { reference: patientUUID },
        effectiveDateTime: record.date,
        component: [
            { code: { coding: [{ system: "http://loinc.org", code: "8480-6", display: "Systolic blood pressure" }] }, valueQuantity: { value: parseFloat(record.systolic), unit: "mmHg", system: "http://unitsofmeasure.org", code: "mm[Hg]" } },
            { code: { coding: [{ system: "http://loinc.org", code: "8462-4", display: "Diastolic blood pressure" }] }, valueQuantity: { value: parseFloat(record.diastolic), unit: "mmHg", system: "http://unitsofmeasure.org", code: "mm[Hg]" } },
            { code: { coding: [{ system: "http://loinc.org", code: "8867-4", display: "Heart rate" }] }, valueQuantity: { value: parseFloat(record.pulse), unit: "bpm", system: "http://unitsofmeasure.org", code: "/min" } }
        ],
        note: record.medication ? [{ text: "服藥：是" }] : []
    };
}

function createBsObservation(record, patientUUID) {
    let loinc = "2339-0"; // Random
    if (record.timing === "fasting") loinc = "1585-8";
    if (record.timing === "post-prandial") loinc = "88365-2";

    return {
        resourceType: "Observation",
        id: crypto.randomUUID(),
        status: "final",
        category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "laboratory" }] }],
        code: { coding: [{ system: "http://loinc.org", code: loinc }] },
        subject: { reference: patientUUID },
        effectiveDateTime: record.date,
        valueQuantity: { value: parseFloat(record.value), unit: "mg/dL", system: "http://unitsofmeasure.org", code: "mg/dL" },
        note: [{ text: `時機: ${getMeasurementTimeText(record.timing)}` }].concat(record.medication ? [{ text: "服藥：是" }] : [])
    };
}

function generateFHIRBundle(records, type) {
    const patientUUID = "urn:uuid:" + currentPatient.id;
    const bundle = {
        resourceType: "Bundle",
        id: crypto.randomUUID(),
        meta: { lastUpdated: new Date().toISOString() },
        type: "collection",
        entry: [{ fullUrl: patientUUID, resource: currentPatient }]
    };

    let obsReferences = [];
    records.forEach(rec => {
        const obs = type === 'bp' ? createBpObservation(rec, patientUUID) : createBsObservation(rec, patientUUID);
        const obsUrl = "urn:uuid:" + obs.id;
        bundle.entry.push({ fullUrl: obsUrl, resource: obs });
        obsReferences.push({ reference: obsUrl });
    });

    // 簡單分析用於報告結論
    const analysisResults = type === 'bp' ? analyzeBp(records) : analyzeBs(records);
    let conclusionText = analysisResults.length > 0 
        ? analysisResults.map(r => `[${r.level === 'danger' ? '危險' : '注意'}] ${r.title}`).join('; ')
        : "數據穩定";

    const report = {
        resourceType: "DiagnosticReport",
        id: crypto.randomUUID(),
        status: "final",
        code: { text: `${type === 'bp' ? '血壓' : '血糖'}監測分析報告` },
        subject: { reference: patientUUID },
        effectiveDateTime: new Date().toISOString(),
        result: obsReferences,
        conclusion: conclusionText
    };

    bundle.entry.push({ fullUrl: "urn:uuid:" + report.id, resource: report });
    return bundle;
}

function fhirToText(bundle, type) {
    let text = `==============================\r\n   FHIR R4 ${type === 'bp' ? '血壓' : '血糖'} 報告\r\n==============================\r\n`;
    text += `患者: ${currentPatient.name[0].text} | ID: ${currentPatient.identifier[0].value}\r\n==============================\r\n`;

    const observations = bundle.entry.map(e => e.resource).filter(r => r.resourceType === 'Observation');
    if (observations.length === 0) return text + "無觀測記錄。";

    observations.forEach((obs, idx) => {
        text += `[${idx + 1}] ${formatDateTime(obs.effectiveDateTime)} | `;
        if (type === 'bp') {
            const sys = obs.component.find(c => c.code.coding[0].code === '8480-6').valueQuantity.value;
            const dia = obs.component.find(c => c.code.coding[0].code === '8462-4').valueQuantity.value;
            const pulse = obs.component.find(c => c.code.coding[0].code === '8867-4').valueQuantity.value;
            text += `BP: ${sys}/${dia} mmHg, P: ${pulse}`;
        } else {
            text += `BS: ${obs.valueQuantity.value} mg/dL`;
        }
        if (obs.note && obs.note.some(n => n.text.includes("服藥：是"))) text += " (已服藥)";
        text += "\r\n";
    });

    const report = bundle.entry.find(e => e.resource.resourceType === 'DiagnosticReport');
    if (report && report.conclusion) text += `------------------------------\r\nAI 分析: ${report.conclusion}\r\n`;

    return text.trim().replace(/\r\n/g, '<br>');
}

// ==========================================
// 6. UI 更新與事件 (UI Handling)
// ==========================================
function saveBpRecord(event) {
    event.preventDefault();
    const form = document.getElementById('bp-form');
    const date = form.elements['bp-date'].value;
    const sys = parseInt(form.elements['bp-systolic'].value, 10);
    const dia = parseInt(form.elements['bp-diastolic'].value, 10);
    const pulse = parseInt(form.elements['bp-pulse'].value, 10);

    if (!date || !sys || !dia || !pulse) return Swal.fire('錯誤', '請檢查所有欄位', 'error');

    bpRecords.push({
        date: new Date(date).toISOString(),
        systolic: sys, diastolic: dia, pulse: pulse,
        medication: document.getElementById('bp-medication').checked,
        armPosition: 'N/A'
    });
    
    saveRecords();
    updateHistoryTables();
    updateLatestRecords();
    form.reset();
    document.getElementById('bp-date').value = new Date().toISOString().slice(0, 16);
    Swal.fire('成功', '血壓紀錄已保存!', 'success');
}

function saveBsRecord(e) {
    e.preventDefault();
    const date = document.getElementById('bs-date').value;
    const value = parseFloat(document.getElementById('bs-value').value);
    
    if (isNaN(value) || !date) return Swal.fire('錯誤', '請檢查欄位', 'error');

    bsRecords.push({
        date: new Date(date).toISOString(),
        value: value,
        unit: 'mg/dL',
        timing: document.getElementById('bs-timing').value,
        medication: document.getElementById('bs-medication').checked
    });
    
    saveRecords();
    updateHistoryTables();
    updateLatestRecords();
    document.getElementById('bs-form').reset();
    document.getElementById('bs-date').value = new Date().toISOString().slice(0, 16);
    Swal.fire('成功', '血糖紀錄已保存!', 'success');
}

function renderBpHistory() {
    const tbody = document.getElementById('bp-history');
    tbody.innerHTML = '';
    const sorted = [...bpRecords].sort((a, b) => new Date(b.date) - new Date(a.date));
    
    if (sorted.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted py-3">尚無血壓記錄</td></tr>';
        return;
    }

    sorted.forEach((record) => {
        const originalIndex = bpRecords.indexOf(record);
        const status = getBpStatus(record.systolic, record.diastolic);
        const row = tbody.insertRow();
        row.innerHTML = `
            <td><input type="checkbox" class="form-check-input" data-index="${originalIndex}" data-type="bp"></td>
            <td>${formatDateTime(record.date)}</td>
            <td>${record.systolic}/${record.diastolic} <span class="text-muted small">(${record.pulse})</span></td>
            <td><span class="status-indicator ${status.class}"><i class="${status.icon}"></i> ${status.text}</span></td>
            <td>${record.medication ? '是' : '否'}</td>
        `;
    });
}

function renderBsHistory() {
    const tbody = document.getElementById('bs-history');
    tbody.innerHTML = '';
    const sorted = [...bsRecords].sort((a, b) => new Date(b.date) - new Date(a.date));

    if (sorted.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted py-3">尚無血糖記錄</td></tr>';
        return;
    }

    sorted.forEach((record) => {
        const originalIndex = bsRecords.indexOf(record);
        const status = getBsStatus(record.value, record.timing);
        const row = tbody.insertRow();
        row.innerHTML = `
            <td><input type="checkbox" class="form-check-input" data-index="${originalIndex}" data-type="bs"></td>
            <td>${formatDateTime(record.date)}</td>
            <td>${record.value} ${record.unit}</td>
            <td>${getMeasurementTimeText(record.timing)}</td>
            <td><span class="status-indicator ${status.class}"><i class="${status.icon}"></i> ${status.text}</span></td>
            <td>${record.medication ? '是' : '否'}</td>
        `;
    });
}

function updateHistoryTables() {
    renderBpHistory();
    renderBsHistory();
    renderTrendCharts();
}

function updateLatestRecords() {
    // 最新血壓
    const latestBp = bpRecords.length > 0 ? bpRecords.reduce((a, b) => new Date(a.date) > new Date(b.date) ? a : b) : null;
    if (latestBp) {
        const status = getBpStatus(latestBp.systolic, latestBp.diastolic);
        document.getElementById('latest-bp-sys').textContent = latestBp.systolic;
        document.getElementById('latest-bp-dia').textContent = latestBp.diastolic;
        document.getElementById('latest-bp-pulse').textContent = latestBp.pulse;
        document.getElementById('latest-bp-time').textContent = formatDateTime(latestBp.date);
        const badge = document.getElementById('bp-status-badge');
        badge.className = `badge bg-${status.class === 'normal' ? 'success' : status.class === 'danger' ? 'danger' : 'warning text-dark'}`;
        badge.textContent = status.text;
    }

    // 最新血糖
    const latestBs = bsRecords.length > 0 ? bsRecords.reduce((a, b) => new Date(a.date) > new Date(b.date) ? a : b) : null;
    if (latestBs) {
        const status = getBsStatus(latestBs.value, latestBs.timing);
        document.getElementById('latest-bs-value').textContent = latestBs.value;
        document.getElementById('latest-bs-time-type').textContent = getMeasurementTimeText(latestBs.timing);
        document.getElementById('latest-bs-time').textContent = formatDateTime(latestBs.date);
        const badge = document.getElementById('bs-status-badge');
        badge.className = `badge bg-${status.class === 'normal' ? 'success' : status.class === 'danger' ? 'danger' : 'warning text-dark'}`;
        badge.textContent = status.text;
    }
}

// 生成並顯示 FHIR Modal
function generateFHIRFromHistory(type) {
    const checkboxes = document.querySelectorAll(`#${type}-history input[type="checkbox"]:checked`);
    const indices = Array.from(checkboxes).map(c => parseInt(c.getAttribute('data-index')));
    
    if (indices.length === 0) return Swal.fire('提示', '請先勾選記錄', 'warning');
    if (currentPatient.name[0].text === "未設定姓名") return Swal.fire('錯誤', '請先設定患者資訊', 'error');

    const records = (type === 'bp' ? bpRecords : bsRecords).filter((_, i) => indices.includes(i));
    const bundle = generateFHIRBundle(records, type);
    showFHIRModal(bundle, `FHIR R4 ${type === 'bp' ? '血壓' : '血糖'} 報告`, type);
}

function showFHIRModal(bundle, title, type) {
    const modal = new bootstrap.Modal(document.getElementById('fhirModal'));
    document.getElementById('fhir-modal-title').textContent = title;
    
    // QR Code 處理
    const qrContainer = document.getElementById('qrcode');
    qrContainer.innerHTML = '';
    
    // 顯示內容
    const fullJson = JSON.stringify(bundle, null, 2);
    document.getElementById('fhir-content-display').textContent = fullJson;
    document.getElementById('text-report-display').innerHTML = fhirToText(bundle, type);
    
    // UI 切換
    const textBtn = document.getElementById('text-format-btn');
    const fhirBtn = document.getElementById('fhir-format-btn');
    const textDiv = document.getElementById('text-report-display');
    const fhirDiv = document.getElementById('fhir-content-display');

    textBtn.onclick = () => {
        textDiv.classList.remove('d-none'); fhirDiv.classList.add('d-none');
        textBtn.classList.add('btn-primary'); textBtn.classList.remove('btn-outline-primary');
        fhirBtn.classList.add('btn-outline-primary'); fhirBtn.classList.remove('btn-primary');
    };
    fhirBtn.onclick = () => {
        textDiv.classList.add('d-none'); fhirDiv.classList.remove('d-none');
        fhirBtn.classList.add('btn-primary'); fhirBtn.classList.remove('btn-outline-primary');
        textBtn.classList.add('btn-outline-primary'); textBtn.classList.remove('btn-primary');
    };
    
    // 觸發按鈕重置
    textBtn.click();

    // QR Code 生成 (精簡版)
    setTimeout(() => {
        try {
            let miniBundle = JSON.parse(fullJson);
            // 只保留最新的3筆 observation 防止 QR code 過大
            const obsIndices = miniBundle.entry.map((e, i) => e.resource.resourceType === 'Observation' ? i : -1).filter(i => i !== -1);
            if (obsIndices.length > 3) {
                miniBundle.entry.splice(1, obsIndices.length - 3);
                miniBundle.entry.find(e => e.resource.resourceType === 'DiagnosticReport').resource.conclusion += " (QR Code 僅含部分數據)";
            }
            new QRCode(qrContainer, {
                text: btoa(unescape(encodeURIComponent(JSON.stringify(miniBundle)))),
                width: 180, height: 180, correctLevel: QRCode.CorrectLevel.L
            });
        } catch (e) {
            qrContainer.innerText = "數據過大，無法生成 QR Code";
        }
    }, 100);

    modal.show();
}

function copyFhirContent(elementId) {
    const el = document.getElementById(elementId);
    navigator.clipboard.writeText(el.tagName === 'PRE' ? el.textContent : el.innerText)
        .then(() => Swal.fire({ icon: 'success', title: '複製成功', timer: 1000, showConfirmButton: false }))
        .catch(() => Swal.fire('失敗', '無法複製', 'error'));
}

function sendReportFromHistory(type) {
    const checkboxes = document.querySelectorAll(`#${type}-history input[type="checkbox"]:checked`);
    if (checkboxes.length === 0) return Swal.fire('提示', '請先勾選記錄', 'warning');

    const indices = Array.from(checkboxes).map(c => parseInt(c.getAttribute('data-index')));
    const records = (type === 'bp' ? bpRecords : bsRecords).filter((_, i) => indices.includes(i));
    const bundle = generateFHIRBundle(records, type);

    Swal.fire({
        title: '輸入收件人 Gmail',
        input: 'email',
        showCancelButton: true,
        confirmButtonText: '發送'
    }).then((result) => {
        if (result.isConfirmed) {
            const body = fhirToText(bundle, type).replace(/<br>/g, '\r\n').replace(/\|/g, '-');
            window.location.href = `mailto:${result.value}?subject=${encodeURIComponent(`慢性病報告 (${type})`)}&body=${encodeURIComponent(body)}`;
        }
    });
}

// ==========================================
// 7. OCR 辨識 (Tesseract.js)
// ==========================================
async function handleOCR(type) {
    const input = document.getElementById(type === 'bp' ? 'bp-image' : 'bs-image');
    if (!input.files[0]) return Swal.fire('請選擇圖片', '請先上傳照片', 'warning');

    if (!tesseractWorker) {
        Swal.fire({ title: '載入辨識核心...', text: '首次需下載語言包，請稍候...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
        try {
            tesseractWorker = await Tesseract.createWorker('eng+chi_tra');
        } catch {
            tesseractWorker = await Tesseract.createWorker('eng');
        }
    }

    Swal.fire({ title: 'AI 辨識中...', text: '正在分析數值...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });

    try {
        const { data: { text } } = await tesseractWorker.recognize(input.files[0]);
        Swal.close();
        const rawLower = text.toLowerCase();

        if (type === 'bp') parseBloodPressureOCR(rawLower);
        else parseBloodSugarOCR(rawLower);
    } catch (e) {
        console.error(e);
        Swal.fire('錯誤', '辨識失敗，請確保圖片清晰', 'error');
    }
}

function parseBloodPressureOCR(text) {
    if (text.includes('mg/dl') || text.includes('glucose')) return Swal.fire('錯誤', '這看起來像是血糖機照片', 'error');

    let sys, dia, pulse;
    // 嘗試解析 120/80 格式
    const slashMatch = text.match(/(\d{2,3})\s*[\/\-]\s*(\d{2,3})/);
    if (slashMatch) { sys = parseInt(slashMatch[1]); dia = parseInt(slashMatch[2]); }
    
    // 嘗試解析 Pulse
    const pulseMatch = text.match(/(pulse|bpm|hr|心率|脈搏)[\D]*(\d{2,3})/);
    if (pulseMatch) pulse = parseInt(pulseMatch[2]);

    // 盲猜數字邏輯 (如果正則失敗)
    if (!sys || !dia) {
        const nums = (text.match(/\d{2,3}/g) || []).map(n => parseInt(n)).filter(n => n > 40 && n < 220);
        const unique = [...new Set(nums)].sort((a, b) => b - a);
        if (unique.length >= 2) { sys = unique[0]; dia = unique[1]; }
        if (!pulse && unique.length >= 3) pulse = unique[2] < sys ? unique[2] : null;
    }

    if (sys && dia) {
        if (sys < dia) [sys, dia] = [dia, sys];
        document.getElementById('bp-systolic').value = sys;
        document.getElementById('bp-diastolic').value = dia;
        if (pulse) document.getElementById('bp-pulse').value = pulse;
        Swal.fire('成功', `讀取到: ${sys}/${dia} mmHg`, 'success');
    } else {
        Swal.fire('失敗', '無法識別血壓數值', 'error');
    }
}

function parseBloodSugarOCR(text) {
    if (/\d{2,3}\s*[\/]\s*\d{2,3}/.test(text) || text.includes('mmhg')) return Swal.fire('錯誤', '這看起來像是血壓計照片', 'error');

    let val = null;
    const unitMatch = text.match(/(\d{2,3})\s*(mg|glu|blo)/);
    if (unitMatch) val = parseInt(unitMatch[1]);
    
    if (!val) {
        const nums = (text.match(/\d{2,3}/g) || []).map(n => parseInt(n)).filter(n => n > 20 && n < 600);
        if (nums.length === 1) val = nums[0]; // 畫面上只有一個大數字
        else if (nums.length > 1) val = nums[0]; // 取第一個
    }

    if (val) {
        document.getElementById('bs-value').value = val;
        Swal.fire('成功', `讀取到血糖: ${val}`, 'success');
    } else {
        Swal.fire('失敗', '找不到血糖數值', 'error');
    }
}

// ==========================================
// 8. 數據分析與建議 (Analysis)
// ==========================================
function analyzeBs(records) {
    const recs = [];
    const recent = records.filter(r => (new Date() - new Date(r.date)) / 86400000 <= 7);
    if (recent.length === 0) return recs;

    const fast = recent.filter(r => r.timing === 'fasting').map(r => r.value);
    if (fast.length) {
        const avg = fast.reduce((a,b)=>a+b,0)/fast.length;
        if (avg >= 126) recs.push({ level: 'danger', title: '空腹血糖過高', message: `平均 ${avg.toFixed(0)}` });
        else if (avg >= 100) recs.push({ level: 'warning', title: '空腹血糖偏高', message: `平均 ${avg.toFixed(0)}` });
    }
    return recs;
}

function analyzeBp(records) {
    const recs = [];
    const recent = records.filter(r => (new Date() - new Date(r.date)) / 86400000 <= 7);
    if (recent.length >= 3) {
        const avgSys = recent.reduce((a,r)=>a+r.systolic,0)/recent.length;
        const avgDia = recent.reduce((a,r)=>a+r.diastolic,0)/recent.length;
        if (avgSys >= 140 || avgDia >= 90) recs.push({ level: 'danger', title: '血壓偏高', message: `平均 ${avgSys.toFixed(0)}/${avgDia.toFixed(0)}` });
        else if (avgSys >= 130 || avgDia >= 80) recs.push({ level: 'warning', title: '血壓注意', message: `平均 ${avgSys.toFixed(0)}/${avgDia.toFixed(0)}` });
    }
    return recs;
}

function generateAndRenderRecommendations() {
    const container = document.getElementById('recommendations-container');
    if (!container) return; // 頁面可能沒有這個容器
    const all = [...analyzeBs(bsRecords), ...analyzeBp(bpRecords)];
    
    container.innerHTML = all.length === 0 
        ? `<div class="alert alert-success"><i class="fas fa-check-circle me-2"></i>數據穩定</div>`
        : all.map(r => `<div class="alert alert-${r.level} alert-dismissible fade show"><strong>${r.title}</strong>: ${r.message}<button type="button" class="btn-close" data-bs-dismiss="alert"></button></div>`).join('');
}

// ==========================================
// 9. 圖表繪製 (Charts)
// ==========================================
function renderTrendCharts() {
    // 1. 小圖表 (如果有的話)
    if (typeof Chart === 'undefined') return;

    // 血壓圖
    const bpCtx = document.getElementById('bpChart');
    if (bpCtx) {
        if (bpChartInstance) bpChartInstance.destroy();
        const sorted = [...bpRecords].sort((a, b) => new Date(a.date) - new Date(b.date));
        bpChartInstance = new Chart(bpCtx, {
            type: 'line',
            data: {
                labels: sorted.map(r => formatDateTime(r.date)),
                datasets: [
                    { label: '收縮壓', data: sorted.map(r => r.systolic), borderColor: 'rgb(255, 99, 132)' },
                    { label: '舒張壓', data: sorted.map(r => r.diastolic), borderColor: 'rgb(53, 162, 235)' }
                ]
            }
        });
    }

    // 血糖圖
    const bsCtx = document.getElementById('bsChart');
    if (bsCtx) {
        if (bsChartInstance) bsChartInstance.destroy();
        const sorted = [...bsRecords].sort((a, b) => new Date(a.date) - new Date(b.date));
        bsChartInstance = new Chart(bsCtx, {
            type: 'line',
            data: {
                labels: sorted.map(r => formatDateTime(r.date)),
                datasets: [{ label: '血糖', data: sorted.map(r => r.value), borderColor: 'rgb(75, 192, 192)' }]
            }
        });
    }
    
    // 如果目前在趨勢分頁，更新大圖表
    const trendTab = document.getElementById('trend-tab');
    if (trendTab && trendTab.classList.contains('active')) {
        renderMedicationChart();
    }
    
    generateAndRenderRecommendations();
}

// 繪製整合圖表 (含藥物點)
function renderMedicationChart() {
    const ctx = document.getElementById('medication-trend-chart');
    if (!ctx) return;
    if (medChartInstance) medChartInstance.destroy();

    const mode = document.getElementById('chart-view-mode')?.value || 'bp'; // 預設血壓
    let healthData = [], label = "", color = "", yTitle = "";

    if (mode === 'bs') {
        healthData = bsRecords.map(r => ({ x: new Date(r.date), y: parseFloat(r.value) }));
        label = "血糖 (mg/dL)"; color = "#fd7e14"; yTitle = "血糖 (mg/dL)";
    } else {
        healthData = bpRecords.map(r => ({ x: new Date(r.date), y: parseFloat(r.systolic) }));
        label = "收縮壓 (mmHg)"; color = "#0d6efd"; yTitle = "血壓 (mmHg)";
    }
    healthData.sort((a, b) => a.x - b.x);

    const maxY = healthData.length > 0 ? Math.max(...healthData.map(d => d.y)) : 150;
    const medPoints = medRecords.map(m => ({ x: new Date(m.date), y: maxY * 1.05, drugName: m.name }));

    medChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            datasets: [
                { label: label, data: healthData, borderColor: color, backgroundColor: color + '20', fill: false, tension: 0.3, order: 2 },
                { type: 'scatter', label: '服藥', data: medPoints, backgroundColor: '#dc3545', pointStyle: 'circle', pointRadius: 6, order: 1 }
            ]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            scales: {
                x: { type: 'time', time: { unit: 'day', tooltipFormat: 'yyyy/MM/dd HH:mm' }, title: { display: true, text: '時間' } },
                y: { title: { display: true, text: yTitle } }
            },
            plugins: {
                tooltip: {
                    callbacks: {
                        label: ctx => ctx.datasetIndex === 1 ? `服藥：${ctx.raw.drugName}` : `${ctx.dataset.label}: ${ctx.raw.y}`
                    }
                }
            }
        }
    });
}

// ==========================================
// 10. 藥物管理邏輯 (Medication Management)
// ==========================================
function filterDrugList() {
    const category = document.getElementById('med-category-select').value;
    const datalist = document.getElementById('drug-datalist');
    datalist.innerHTML = ''; 

    const filtered = (category === 'all') ? drugDatabase : drugDatabase.filter(d => d.category === category);
    filtered.forEach(drug => {
        const option = document.createElement('option');
        option.value = drug.name;
        datalist.appendChild(option);
    });
}

function checkInteractions() {
    const inputName = document.getElementById('med-name-input').value;
    const alertBox = document.getElementById('interaction-alert');
    const infoCard = document.getElementById('med-info-card');
    
    alertBox.classList.add('d-none');
    infoCard.classList.add('d-none');
    
    const drug = drugDatabase.find(d => d.name === inputName);
    if (drug) {
        infoCard.classList.remove('d-none');
        document.getElementById('med-side-effect').textContent = drug.sideEffect;
        
        let warning = "";
        if (drug.interactions.includes("diabetes")) warning = "此藥可能影響血糖，請密切監測。";
        else if (drug.interactions.includes("hypertension")) warning = "此藥可能與血壓藥交互作用。";
        else if (drug.interactions.includes("depression")) warning = "可能影響情緒穩定劑代謝。";

        if (warning) {
            alertBox.classList.remove('d-none');
            document.getElementById('interaction-msg').textContent = warning;
            document.getElementById('med-risk-badge').classList.remove('d-none');
        } else {
            document.getElementById('med-risk-badge').classList.add('d-none');
        }
    }
}

function addMedicationRecord() {
    const name = document.getElementById('med-name-input').value;
    const time = document.getElementById('med-time-input').value;
    
    if (!name || !time) return Swal.fire('提示', '請填寫藥物名稱與時間', 'warning');

    const drug = drugDatabase.find(d => d.name === name);
    medRecords.push({
        id: Date.now(),
        name: name,
        date: new Date(time).toISOString(),
        category: drug ? drug.category : 'other',
        note: drug ? drug.sideEffect : "無特殊備註"
    });

    saveMedRecords();
    renderMedList();
    
    document.getElementById('med-name-input').value = '';
    document.getElementById('med-info-card').classList.add('d-none');
    document.getElementById('interaction-alert').classList.add('d-none');
    
    Swal.fire({ icon: 'success', title: '紀錄成功', timer: 1000, showConfirmButton: false });
}

function renderMedList() {
    const list = document.getElementById('med-record-list');
    if (!list) return;
    
    if (medRecords.length === 0) {
        list.innerHTML = '<li class="list-group-item text-muted p-3">暫無紀錄</li>';
        return;
    }

    const recent = [...medRecords].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 5);
    list.innerHTML = recent.map(r => `
        <li class="list-group-item d-flex justify-content-between align-items-center">
            <div>
                <span class="badge bg-secondary me-2">${formatDateTime(r.date)}</span>
                <strong class="text-primary">${r.name}</strong>
                <br><small class="text-muted"><i class="fas fa-info-circle me-1"></i>${r.note}</small>
            </div>
            <button class="btn btn-sm btn-outline-danger" onclick="deleteMedRecord(${r.id})"><i class="fas fa-trash"></i></button>
        </li>
    `).join('');
}

function deleteMedRecord(id) {
    medRecords = medRecords.filter(r => r.id !== id);
    saveMedRecords();
    renderMedList();
    if (document.getElementById('trend-tab').classList.contains('active')) renderMedicationChart();
}

// ==========================================
// 11. 初始化與事件綁定 (Initialization)
// ==========================================
function init() {
    loadAllData();
    initializePatient();
    
    updatePatientDisplay();
    updateHistoryTables();
    updateLatestRecords();
    
    renderMedList();
    filterDrugList();

    // 設置預設時間
    const now = new Date().toISOString().slice(0, 16);
    ['bp-date', 'bs-date', 'med-time-input'].forEach(id => {
        const el = document.getElementById(id);
        if (el && !el.value) el.value = now;
    });

    // 綁定表單
    document.getElementById('bp-form').addEventListener('submit', saveBpRecord);
    document.getElementById('bs-form').addEventListener('submit', saveBsRecord);
    document.getElementById('patient-info-form').addEventListener('submit', savePatientInfo);

    // 全選功能
    document.getElementById('select-all-bp').addEventListener('change', function() {
        document.querySelectorAll('#bp-history input[type="checkbox"]').forEach(c => c.checked = this.checked);
    });
    document.getElementById('select-all-bs').addEventListener('change', function() {
        document.querySelectorAll('#bs-history input[type="checkbox"]').forEach(c => c.checked = this.checked);
    });

    // Modal 事件
    const patientModal = document.getElementById('patientModal');
    if (patientModal) patientModal.addEventListener('show.bs.modal', populatePatientForm);

    // Tab 切換重繪圖表
    document.getElementById('trend-tab').addEventListener('shown.bs.tab', function() {
        setTimeout(() => {
            renderMedicationChart();
            generateAndRenderRecommendations();
        }, 100);
    });
    
    // 初始圖表
    setTimeout(renderTrendCharts, 500);
}

// 啟動
document.addEventListener('DOMContentLoaded', init);

// 將需要被 HTML onclick 呼叫的函式掛載到 window
window.adjustFontSize = adjustFontSize;
window.handleOCR = handleOCR;
window.generateFHIRFromHistory = generateFHIRFromHistory;
window.sendReportFromHistory = sendReportFromHistory;
window.copyFhirContent = copyFhirContent;
window.filterDrugList = filterDrugList;
window.checkInteractions = checkInteractions;
window.addMedicationRecord = addMedicationRecord;
window.deleteMedRecord = deleteMedRecord;
// 其它 HTML 直接呼叫的函數也需確保全域可見

// ==========================================
// 12. MQTT 即時同步功能 (GitHub Pages HTTPS 修正版)
// ==========================================
let mqttClient = null;
let syncTopicId = localStorage.getItem('cig_sync_topic') || null;

// --- 關鍵修正：針對 GitHub Pages 的 HTTPS 必須使用 WSS 協議 ---
const MQTT_BROKER = "broker.hivemq.com";
const MQTT_PORT = 8884; // HiveMQ 的 WSS 端口是 8884 (8000 是不安全的 WS)
let isMqttConnected = false;

function initSync(onConnectCallback) {
    if (!syncTopicId) {
        syncTopicId = 'cig_user_' + Math.random().toString(36).substring(2, 10);
        localStorage.setItem('cig_sync_topic', syncTopicId);
    }

    if (mqttClient && isMqttConnected) {
        if (onConnectCallback) onConnectCallback();
        return;
    }

    const clientId = "patient_" + Math.random().toString(16).substr(2, 8);
    mqttClient = new Paho.MQTT.Client(MQTT_BROKER, Number(MQTT_PORT), clientId);

    mqttClient.onConnectionLost = (responseObject) => {
        console.warn("MQTT 斷線: " + responseObject.errorMessage);
        isMqttConnected = false;
        setTimeout(() => initSync(), 5000); 
    };

    console.log("正在連接 MQTT Broker (WSS)...");
    mqttClient.connect({
        onSuccess: () => {
            console.log("✅ MQTT 連線成功! Topic:", syncTopicId);
            isMqttConnected = true;
            if (onConnectCallback) onConnectCallback();
            setTimeout(pushDataToCloud, 500);
        },
        onFailure: (ctx) => {
            console.error("❌ MQTT 連線失敗 (請檢查 8884 端口):", ctx.errorMessage);
            isMqttConnected = false;
        },
        useSSL: true, // ★ 重要：在 GitHub Pages (HTTPS) 下必須設為 true
        timeout: 3,
        keepAliveInterval: 30
    });
}

// --- 修正路徑處理：確保能正確找到 GitHub 上的 doctor_view.html ---
showFHIRModal = function(bundle, title, type) {
    if (!syncTopicId) initSync();
    pushDataToCloud(bundle);

    const modal = new bootstrap.Modal(document.getElementById('fhirModal'));
    document.getElementById('fhir-modal-title').textContent = title;
    const qrContainer = document.getElementById('qrcode');
    qrContainer.innerHTML = '';
    
    document.getElementById('fhir-content-display').textContent = JSON.stringify(bundle, null, 2);
    document.getElementById('text-report-display').innerHTML = fhirToText(bundle, type);

    // ★ 路徑修正邏輯：
    // GitHub 網址通常是 https://user.github.io/repo/index.html
    let currentHref = window.location.href;
    let syncUrl = "";

    if (currentHref.includes('index.html')) {
        syncUrl = currentHref.replace('index.html', 'doctor_view.html');
    } else {
        // 如果結尾沒有 index.html (例如 https://.../repo/)
        // 確保結尾有斜線再加檔名
        let baseUrl = currentHref.split('?')[0].split('#')[0];
        syncUrl = baseUrl.endsWith('/') ? baseUrl + 'doctor_view.html' : baseUrl + '/../doctor_view.html';
    }
    
    // 清除重複斜線並加上 Topic ID
    syncUrl = new URL(syncUrl, window.location.href).href + `?topic=${syncTopicId}`;
    
    console.log("GitHub QR Code Link:", syncUrl);

    new QRCode(qrContainer, {
        text: syncUrl,
        width: 180, height: 180, correctLevel: QRCode.CorrectLevel.L
    });

    // 提示文字
    const hint = document.createElement('div');
    hint.className = 'mt-2';
    hint.innerHTML = `
        <p class="text-success fw-bold mb-1"><i class="fas fa-wifi me-1"></i>雲端同步頻道建立完成</p>
        <small class="text-muted d-block mb-2">Topic ID: ${syncTopicId}</small>
        <button class="btn btn-sm btn-outline-primary" onclick="pushDataToCloud()">
            <i class="fas fa-sync me-1"></i>手動重推數據
        </button>
    `;
    qrContainer.appendChild(hint);

    modal.show();
    
    // UI Tab 切換 (保持原樣)
    const textBtn = document.getElementById('text-format-btn');
    const fhirBtn = document.getElementById('fhir-format-btn');
    const textDiv = document.getElementById('text-report-display');
    const fhirDiv = document.getElementById('fhir-content-display');
    
    textBtn.onclick = () => { textDiv.classList.remove('d-none'); fhirDiv.classList.add('d-none'); };
    fhirBtn.onclick = () => { textDiv.classList.add('d-none'); fhirDiv.classList.remove('d-none'); };
}

// 初始化
const originalInit = init;
init = function() {
    originalInit();
    // 啟動時就連線，隨時準備
    initSync(); 
}

// 新增：创建 MedicationStatement 资源
function createMedicationStatement(medRecord, patientUUID) {
    return {
        resourceType: "MedicationStatement",
        id: crypto.randomUUID(),
        status: "active",
        medicationCodeableConcept: {
            coding: [{
                system: "http://www.nlm.nih.gov/research/umls/rxnorm",
                code: "medication",
                display: medRecord.name
            }],
            text: medRecord.name
        },
        subject: { reference: patientUUID },
        effectiveDateTime: medRecord.date,
        dateAsserted: new Date().toISOString(),
        informationSource: { reference: patientUUID },
        note: [{ text: `藥物類別: ${medRecord.category || '一般用藥'}` }]
    };
}

// 新增：创建 MedicationRequest 资源（处方）
function createMedicationRequest(medRecord, patientUUID) {
    return {
        resourceType: "MedicationRequest",
        id: crypto.randomUUID(),
        status: "active",
        intent: "order",
        medicationCodeableConcept: {
            coding: [{
                system: "http://www.nlm.nih.gov/research/umls/rxnorm", 
                code: "medication",
                display: medRecord.name
            }],
            text: medRecord.name
        },
        subject: { reference: patientUUID },
        authoredOn: medRecord.date,
        requester: { reference: patientUUID },
        note: [{ text: medRecord.note || "患者自行記錄" }]
    };
}
