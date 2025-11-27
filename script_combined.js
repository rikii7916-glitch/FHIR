// 初始化血壓和血糖記錄數組
let bpRecords = [];
let bsRecords = [];
let currentPatient = {}; // 用於儲存患者 FHIR 資源
let tesseractWorker = null; // OCR Worker 實例
let qrcode = null; // 儲存 QRCode 實例

// **********************************************
// 數據存儲和初始化
// **********************************************
function loadRecords() {
	try {
		const storedBp = localStorage.getItem('bpRecords');
		const storedBs = localStorage.getItem('bsRecords');
		if (storedBp) {
			const loadedBp = JSON.parse(storedBp);
			// 簡單兼容性處理
			if (loadedBp.length > 0 && loadedBp[0].dateTime && !loadedBp[0].date) {
				bpRecords = loadedBp.map(r => ({
					date: new Date(r.dateTime).toISOString(),
					systolic: r.systolic,
					diastolic: r.diastolic,
					pulse: r.pulse,
					medication: r.medicationTaken || false,
					armPosition: 'N/A' 
				}));
			} else {
				bpRecords = loadedBp;
			}
		}
		if (storedBs) {
			const loadedBs = JSON.parse(storedBs);
			if (loadedBs.length > 0 && loadedBs[0].dateTime && !loadedBs[0].date) {
				bsRecords = loadedBs.map(r => ({
					date: new Date(r.dateTime).toISOString(),
					value: r.value,
					unit: 'mg/dL', 
					timing: r.measurementTime,
					medication: r.medicationTaken || false
				}));
			} else {
				bsRecords = loadedBs;
			}
		}
	} catch (e) {
		console.error('Error loading records from localStorage:', e);
		bpRecords = [];
		bsRecords = [];
	}
}

function saveRecords() {
	try {
		localStorage.setItem('bpRecords', JSON.stringify(bpRecords));
		localStorage.setItem('bsRecords', JSON.stringify(bsRecords));
	} catch (e) {
		console.error('Error saving records to localStorage:', e);
	}
}

function createDefaultPatient() {
	return {
		resourceType: "Patient",
		id: crypto.randomUUID(),
		meta: { lastUpdated: new Date().toISOString() },
		text: { status: "generated", div: "<div xmlns=\"http://www.w3.org/1999/xhtml\">默認患者資料</div>" },
		identifier: [{
			use: "usual",
			type: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v2-0203", code: "MR", display: "Medical Record Number" }] },
			system: "urn:oid:1.2.36.1.4.1.30008.2.1.1.1",
			value: "未設定-1"
		}],
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
			// 確保 name 數組存在
			if (!currentPatient.name || currentPatient.name.length === 0) {
				currentPatient.name = [{ use: "usual", text: "未設定姓名" }];
			}
			// 確保 identifier 數組存在
			if (!currentPatient.identifier || currentPatient.identifier.length === 0) {
				currentPatient.identifier = [{ use: "usual", value: currentPatient.id || "未設定-1" }];
			}
		} catch (e) {
			console.error('Error parsing stored patient data:', e);
			currentPatient = createDefaultPatient();
		}
	} else {
		currentPatient = createDefaultPatient();
		localStorage.setItem('fhirPatient', JSON.stringify(currentPatient));
	}
}

// **********************************************
// 資料處理與格式化
// **********************************************
function formatDateTime(isoString) {
	if (!isoString) return '--';
	const date = new Date(isoString);
	// 格式化為 YYYY/MM/DD HH:mm (本地時間)
	return `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

// 根據 FHIR gender code 返回顯示文本
function getGenderDisplay(gender) {
	switch (gender) {
		case 'male':
			return '男性';
		case 'female':
			return '女性';
		case 'other':
			return '其他';
		default:
			return '未知';
	}
}

// 血壓狀態判斷
function getBpStatus(systolic, diastolic) {
	let status = { text: '正常', class: 'normal', icon: 'fas fa-check-circle' };
	if (systolic >= 140 || diastolic >= 90) {
		status = { text: '偏高', class: 'danger', icon: 'fas fa-exclamation-triangle' };
	} else if (systolic >= 130 || diastolic >= 80) {
		status = { text: '血壓升高', class: 'warning', icon: 'fas fa-exclamation-circle' };
	} else if (systolic < 90 || diastolic < 60) {
		status = { text: '低血壓', class: 'primary', icon: 'fas fa-info-circle' };
	}
	return status;
}

// 血糖狀態判斷
function getBsStatus(value, timing) {
	let upperLimit;
	// 假設單位是 mg/dL
	if (timing === 'fasting') { upperLimit = 100; } 
	else if (timing === 'before-meal') { upperLimit = 130; } 
	else if (timing === 'post-prandial') { upperLimit = 180; } 
	else { upperLimit = 140; } 

	let status = { text: '正常', class: 'normal', icon: 'fas fa-check-circle' };
	if (value < 70) {
		status = { text: '偏低', class: 'warning', icon: 'fas fa-arrow-down' };
	} else if (value > upperLimit) {
		status = { text: '偏高', class: 'danger', icon: 'fas fa-exclamation-triangle' };
	}
	return status;
}

// 獲取測量時機文本
function getMeasurementTimeText(measurementTime) {
	switch (measurementTime) {
		case 'fasting':
			return '空腹';
		case 'before-meal':
			return '飯前';
		case 'post-prandial':
			return '飯後';
		case 'before-sleep':
			return '睡前';
		default:
			return measurementTime;
	}
}


// **********************************************
// FHIR 資源生成 (Request 1 - 修正與製作)
// **********************************************

// 根據記錄創建 Observation 資源
function createObservationResource(record, type) {
	const subjectRef = {
		reference: `Patient/${currentPatient.id}`,
		display: currentPatient.name[0] ? currentPatient.name[0].text : '未知患者'
	};

	if (type === 'bp') {
		// 血壓 (Blood Pressure)
		return {
			resourceType: "Observation",
			id: crypto.randomUUID(),
			meta: {
				profile: ["http://hl7.org/fhir/StructureDefinition/bp"]
			},
			status: "final",
			category: [{
				coding: [{
					system: "http://terminology.hl7.org/CodeSystem/observation-category",
					code: "vital-signs",
					display: "Vital Signs"
				}]
			}],
			code: {
				coding: [{
					system: "http://loinc.org",
					code: "85354-9",
					display: "Blood pressure panel"
				}],
				text: "血壓測量"
			},
			subject: subjectRef,
			effectiveDateTime: record.date,
			issued: new Date().toISOString(),
			component: [{
				code: {
					coding: [{ system: "http://loinc.org", code: "8480-6", display: "Systolic blood pressure" }],
					text: "收縮壓"
				},
				valueQuantity: {
					value: record.systolic,
					unit: "mmHg",
					system: "http://unitsofmeasure.org",
					code: "mm[Hg]"
				}
			}, {
				code: {
					coding: [{ system: "http://loinc.org", code: "8462-4", display: "Diastolic blood pressure" }],
					text: "舒張壓"
				},
				valueQuantity: {
					value: record.diastolic,
					unit: "mmHg",
					system: "http://unitsofmeasure.org",
					code: "mm[Hg]"
				}
			}, {
				code: {
					coding: [{ system: "http://loinc.org", code: "8867-4", display: "Heart rate" }],
					text: "脈搏"
				},
				valueQuantity: {
					value: record.pulse,
					unit: "bpm",
					system: "http://unitsofmeasure.org",
					code: "/min"
				}
			}],
			note: record.medication ? [{ text: "服藥：是" }] : []
		};
	} else if (type === 'bs') {
		// 血糖 (Blood Glucose)
		const timingCode = record.timing === 'fasting' ? '1585-8' : record.timing === 'post-prandial' ? '88365-2' : '2339-0'; 
		const codeSystem = "http://loinc.org";

		return {
			resourceType: "Observation",
			id: crypto.randomUUID(),
			meta: {
				profile: ["http://hl7.org/fhir/StructureDefinition/glucose"]
			},
			status: "final",
			category: [{
				coding: [{
					system: "http://terminology.hl7.org/CodeSystem/observation-category",
					code: "laboratory",
					display: "Laboratory"
				}]
			}],
			code: {
				coding: [{
					system: codeSystem,
					code: timingCode,
					display: "Glucose"
				}],
				text: `${getMeasurementTimeText(record.timing)}血糖`
			},
			subject: subjectRef,
			effectiveDateTime: record.date,
			valueQuantity: {
				value: record.value,
				unit: 'mg/dL', 
				system: "http://unitsofmeasure.org",
				code: "mg/dL"
			},
			note: [{ text: `時機: ${getMeasurementTimeText(record.timing)}` }].concat(record.medication ? [{ text: "服藥：是" }] : [])
		};
	}
	return null;
}

// 生成 FHIR Bundle 資源
function generateFHIRBundle(records, type) {
	const bundle = {
		resourceType: "Bundle",
		id: crypto.randomUUID(),
		meta: {
			lastUpdated: new Date().toISOString()
		},
		type: "collection",
		timestamp: new Date().toISOString(),
		entry: []
	};

	// Patient 資源
	bundle.entry.push({
		fullUrl: `Patient/${currentPatient.id}`,
		resource: currentPatient
	});

	// Observation 資源
	const observationEntries = records.map((record) => {
		const resource = createObservationResource(record, type);
		if (resource) {
			return {
				fullUrl: `Observation/${resource.id}`,
				resource: resource
			};
		}
		return null;
	}).filter(e => e !== null);

	bundle.entry.push(...observationEntries);

	return bundle;
}

// **********************************************
// 文字報告生成 (Request 2 - 修正格式：不換行)
// **********************************************
function fhirToText(resource, type) {
	let text = `==============================\r\n`;
	text += `   FHIR R4 ${type === 'bp' ? '血壓' : '血糖'} 報告\r\n`;
	text += `==============================\r\n`;
	
	const patientEntry = resource.entry.find(e => e.resource.resourceType === 'Patient');
	if (!patientEntry) {
		text += "無法找到患者資訊。\r\n";
		return text.trim().replace(/\r\n/g, '<br>');
	}
	const patient = patientEntry.resource;
	
	const observations = resource.entry.filter(e => e.resource.resourceType === 'Observation').map(e => e.resource);

	const patientName = patient.name && patient.name[0] ? patient.name[0].text : 'N/A';
	const patientId = patient.identifier && patient.identifier[0] ? patient.identifier[0].value : 'N/A';
	const patientGender = getGenderDisplay(patient.gender) || 'N/A';
	const patientBirthYear = patient.birthDate ? patient.birthDate.substring(0, 4) : 'N/A';

	text += `患者資訊: 姓名: ${patientName} | ID: ${patientId} | 性別: ${patientGender} | 出生年: ${patientBirthYear}\r\n`;
	text += `==============================\r\n`;

	if (observations.length === 0) {
		text += "無觀測記錄 (Observation) 可顯示。\r\n";
		return text.trim().replace(/\r\n/g, '<br>');
	}

	text += "測量記錄列表:\r\n" + "=".repeat(30) + "\r\n";
	observations.forEach((observation, idx) => {
		text += `--- 記錄 #${idx + 1} ---`;
		text += ` | 時間: ${formatDateTime(observation.effectiveDateTime)}`;

		if (type === 'bp') {
			const systolic = observation.component.find(comp => comp.code.coding.some(coding => coding.code === "8480-6"));
			const diastolic = observation.component.find(comp => comp.code.coding.some(coding => coding.code === "8462-4"));
			const pulse = observation.component.find(comp => comp.code.coding.some(coding => coding.code === "8867-4"));

			const sysValue = systolic ? systolic.valueQuantity.value : 'N/A';
			const diaValue = diastolic ? diastolic.valueQuantity.value : 'N/A';
			const pulseValue = pulse ? pulse.valueQuantity.value : 'N/A';

			// 修正為不換行顯示，並使用 (S) (D) 縮寫 (Request 2)
			const bpStatusObj = getBpStatus(sysValue, diaValue);
			text += ` | 收縮壓(S): ${sysValue} mmHg | 舒張壓(D): ${diaValue} mmHg | 脈搏(P): ${pulseValue} bpm | 狀態: ${bpStatusObj.text}\r\n`;
		} else if (type === 'bs') {
			const value = observation.valueQuantity.value;
			const unit = observation.valueQuantity.unit;
			const timingText = observation.code.text; 
			const bsStatusObj = getBsStatus(value, timingText);

			// 修正為不換行顯示
			text += ` | 血糖值: ${value} ${unit} | 時機: ${timingText} | 狀態: ${bsStatusObj.text}`;
			const medicationNote = observation.note && observation.note.find(n => n.text.includes("服藥：是"));
			if (medicationNote) {
				text += ` | 服藥: 是\r\n`;
			} else {
				text += ` | 服藥: 否\r\n`;
			}
		}
		text += `------------------------------\r\n`;
	});

	return text.trim().replace(/\r\n/g, '<br>');
}


// **********************************************
// OCR 相關功能 (Request 3 - 啟用與增強)
// **********************************************

// 初始化 Tesseract Worker
async function getTesseractWorker() {
	if (!tesseractWorker) {
		Swal.fire({
			title: '載入辨識核心中...',
			text: '請稍候，此為初次啟動。',
			allowOutsideClick: false,
			didOpen: () => { Swal.showLoading(); }
		});
		// 使用英文+繁體中文進行辨識
		tesseractWorker = await Tesseract.createWorker('eng+chi_tra');
		Swal.close();
	}
	return tesseractWorker;
}

// 解析 OCR 結果 (強化版 - 修正脈搏、血糖值抓取問題)
function parseOCRResult(text, expectedType) {
    // 將所有空格、換行符替換為單一空格，並去除所有非英數字元（除了斜線、點、逗號、冒號、減號），轉為小寫
    const cleanedText = text.toLowerCase().replace(/[\r\n]/g, ' ').replace(/[^\w\d\s\/\.,\-\:]/g, ''); 
    console.log("OCR Cleaned Text:", cleanedText);
    let values = {};
    let matched = false;
    
    // --- 1. 血糖 (BS) 模式 ---
    // 模式 A: 關鍵字 (glc/glucose/sugar/mg/dl/mmol) + 數值
    let bsRegexA = /(?:glc|glucose|sugar|bs|mg\/dl|mmol)\s*[:\-\s]?\s*(\d{2,3}(?:\.\d)?)/; 
    // 模式 B: 僅有三位數（在血糖區塊時，優先匹配，範圍 30-600）
    let bsRegexB = expectedType === 'bs' ? /\b(\d{2,3})\b/ : null; 

    let bsMatch = cleanedText.match(bsRegexA);
    if (bsMatch) {
        values.value = parseFloat(bsMatch[1]);
        matched = true;
    } else if (bsRegexB) {
        // 如果模式 A 沒找到，嘗試模式 B
        bsMatch = cleanedText.match(bsRegexB);
        if (bsMatch && parseInt(bsMatch[1]) > 30 && parseInt(bsMatch[1]) < 600) { 
             values.value = parseInt(bsMatch[1]);
             matched = true;
        }
    }

    if (matched && expectedType === 'bs') {
        values.value = Math.round(values.value); 
        return { classifiedType: 'bs', values: values };
    }


    // --- 2. 血壓/脈搏 (BP/Pulse) 模式 ---
    let systolic = null;
    let diastolic = null;
    let pulse = null;
    let bpMatched = false;

    // 模式 A: xxx/yyy 格式
    const bpSlashRegex = /(\d{2,3})\s*(\/|\\)\s*(\d{2,3})/; 
    const bpMatch = cleanedText.match(bpSlashRegex);
    if (bpMatch) {
        systolic = Math.max(parseInt(bpMatch[1]), parseInt(bpMatch[3]));
        diastolic = Math.min(parseInt(bpMatch[1]), parseInt(bpMatch[3]));
        bpMatched = true;
    }
    
    // 模式 B: Sys/Dia 關鍵字匹配 (更彈性地匹配 s, d, sys, dia)
    const sysRegex = /(?:sys(tolic)?|s)\s*[:\-\s]?\s*(\d{2,3})/;
    const diaRegex = /(?:dia(stolic)?|d)\s*[:\-\s]?\s*(\d{2,3})/;

    const sysMatch = cleanedText.match(sysRegex);
    if (sysMatch) {
        systolic = parseInt(sysMatch[2]);
        bpMatched = true;
    }

    const diaMatch = cleanedText.match(diaRegex);
    if (diaMatch) {
        diastolic = parseInt(diaMatch[2]);
        bpMatched = true;
    }
    
    // 模式 C: 脈搏 (Pulse/HR/P)
    const pulseRegex = /(?:pulse|hr|p)\s*[:\-\s]?\s*(\d{2,3})/;
    const pulseMatch = cleanedText.match(pulseRegex);
    if (pulseMatch) {
        pulse = parseInt(pulseMatch[1]);
    }

    if (bpMatched && expectedType === 'bp' && systolic && diastolic) {
        // 成功匹配到血壓值
        values.systolic = systolic;
        values.diastolic = diastolic;
        values.pulse = pulse && pulse >= 40 && pulse <= 200 ? pulse : 80; // 檢查脈搏範圍，無效則給默認 80
        return { classifiedType: 'bp', values: values };
    }
    
    // --- 3. 處理不匹配 (Mismatch & Failure) ---
    if (expectedType === 'bp' && matched && values.value) { 
        Swal.fire({ icon: 'warning', title: '⚠️ 數據不匹配', html: `系統識別到這是<strong>血糖數據 (${values.value})</strong>，但您正在<strong>血壓監測</strong>區塊。<br>請切換到正確的區塊再試一次。`, confirmButtonText: '確定' });
        return { classifiedType: 'mismatch', values: {} };
    }
    
    if (expectedType === 'bs' && bpMatched) { 
        Swal.fire({ icon: 'warning', title: '⚠️ 數據不匹配', html: `系統識別到這是<strong>血壓數據 (${systolic}/${diastolic})</strong>，但您正在<strong>血糖監測</strong>區塊。<br>請切換到正確的區塊再試一次。`, confirmButtonText: '確定' });
        return { classifiedType: 'mismatch', values: {} };
    }
    
    // 如果是血壓，但收縮壓或舒張壓任一缺失
    if (expectedType === 'bp' && (!systolic || !diastolic)) {
        return { classifiedType: 'bp_fail', values: {} }; 
    }
    
    // 如果是血糖，但數值缺失
    if (expectedType === 'bs' && !values.value) {
        return { classifiedType: 'bs_fail', values: {} };
    }

    return { classifiedType: 'fail', values: {} };
}

// 執行 OCR 辨識
async function handleOCR(type) {
	const fileInputId = type === 'bp' ? 'bp-image' : 'bs-image';
	const fileInput = document.getElementById(fileInputId);
	const imageFile = fileInput.files[0];

	if (!imageFile) {
		Swal.fire({ icon: 'error', title: '未選擇圖片', text: '請先選擇血壓計/血糖儀的照片。', confirmButtonText: '確定' });
		return;
	}

	const worker = await getTesseractWorker(); 

	Swal.fire({
		title: '正在辨識中...',
		text: '這可能需要一些時間...',
		allowOutsideClick: false,
		didOpen: () => Swal.showLoading()
	});

	try {
		// 1. 執行 OCR
		const { data: { text } } = await worker.recognize(imageFile);

		// 2. 解析結果
		const result = parseOCRResult(text, type);
		const { classifiedType, values } = result;

		Swal.close();

		// 3. 檢查分類是否符合
		if (classifiedType.includes('fail') || classifiedType.includes('mismatch')) {
            // parseOCRResult 已經處理了 mismatch 的警告，這裡處理 general fail
            if (classifiedType === 'fail' || classifiedType.includes('_fail')) {
                Swal.fire({ 
                    icon: 'error', 
                    title: '辨識失敗', 
                    html: `無法辨識出有效的 ${type === 'bp' ? '血壓/脈搏' : '血糖'} 數值。<br><strong>OCR 文字結果：</strong><pre style="text-align: left; background: #eee; padding: 10px; white-space: pre-wrap;">${text}</pre>`, 
                    confirmButtonText: '確定' 
                });
            }
			return;
		}

		// 4. 填充表單
		if (type === 'bp' && values.systolic && values.diastolic) {
			document.getElementById('bp-systolic').value = values.systolic;
			document.getElementById('bp-diastolic').value = values.diastolic;
			document.getElementById('bp-pulse').value = values.pulse; 
            
			Swal.fire({ 
                icon: 'success', 
                title: '血壓 OCR 成功', 
                html: `已辨識並填入: <br><strong>收縮壓/舒張壓: ${values.systolic}/${values.diastolic} mmHg, 脈搏: ${values.pulse} bpm</strong><br><br><strong>提醒:</strong> 測量時間請手動核對並調整！`, 
                confirmButtonText: '確定' 
            });
		} else if (type === 'bs' && values.value) {
			document.getElementById('bs-value').value = values.value;
			
			Swal.fire({ 
                icon: 'success', 
                title: '血糖 OCR 成功', 
                html: `已辨識並填入: <br><strong>血糖值: ${values.value} mg/dL</strong><br><br><strong>提醒:</strong> 請務必手動選擇「量測時機」並核對「測量時間」再保存！`, 
                confirmButtonText: '確定' 
            });
		} else {
			Swal.fire({ icon: 'error', title: '辨識失敗', text: '無法從圖片中提取出有效數值。', confirmButtonText: '確定' });
		}

	} catch (error) {
		Swal.fire({ icon: 'error', title: 'OCR 執行錯誤', text: '執行 OCR 辨識時發生錯誤，請檢查圖片或稍後再試。', confirmButtonText: '確定' });
		console.error('OCR Error:', error);
	}
}

// **********************************************
// UI 互動
// **********************************************
function updatePatientDisplay() {
	const name = currentPatient.name && currentPatient.name[0] ? currentPatient.name[0].text : '未知患者';
	const idValue = currentPatient.identifier && currentPatient.identifier[0] ? currentPatient.identifier[0].value : '無 ID';
	document.getElementById('patient-name').textContent = name;
	document.getElementById('patient-id').textContent = idValue;
	const gender = getGenderDisplay(currentPatient.gender);
	document.getElementById('patient-gender-display').textContent = gender;
	
	let ageText = 'N/A';
	if (currentPatient.birthDate) {
		const birthYear = parseInt(currentPatient.birthDate.substring(0, 4));
		const currentYear = new Date().getFullYear();
		if (!isNaN(birthYear)) {
			ageText = `${currentYear - birthYear}`;
		}
	}
	document.getElementById('patient-age').textContent = ageText;
}

function updateHistoryTables() {
	// 血壓歷史記錄 (以最新的在最上面)
	const bpBody = document.getElementById('bp-history');
	bpBody.innerHTML = '';
	const sortedBpRecords = [...bpRecords].sort((a, b) => new Date(b.date) - new Date(a.date));

	if (sortedBpRecords.length === 0) {
		bpBody.innerHTML = '<tr><td colspan="5" class="text-center text-muted py-3">尚無血壓記錄</td></tr>';
	} else {
		sortedBpRecords.forEach((record, index) => {
			const originalIndex = bpRecords.findIndex(r => r === record); 
			const row = bpBody.insertRow();
			const status = getBpStatus(record.systolic, record.diastolic);
			row.innerHTML = `
                <td><input type="checkbox" class="form-check-input" data-index="${originalIndex}" data-type="bp"></td>
                <td>${formatDateTime(record.date)}</td>
                <td>${record.systolic}/${record.diastolic} / ${record.pulse}</td>
                <td><span class="status-indicator ${status.class}"><i class="${status.icon}"></i> ${status.text}</span></td>
                <td>${record.medication ? '是' : '否'}</td>`;
		});
	}

	// 血糖歷史記錄
	const bsBody = document.getElementById('bs-history');
	bsBody.innerHTML = '';
	const sortedBsRecords = [...bsRecords].sort((a, b) => new Date(b.date) - new Date(a.date));

	if (sortedBsRecords.length === 0) {
		bsBody.innerHTML = '<tr><td colspan="6" class="text-center text-muted py-3">尚無血糖記錄</td></tr>';
	} else {
		sortedBsRecords.forEach((record, index) => {
			const originalIndex = bsRecords.findIndex(r => r === record);
			const row = bsBody.insertRow();
			const status = getBsStatus(record.value, record.timing);
			row.innerHTML = `
                <td><input type="checkbox" class="form-check-input" data-index="${originalIndex}" data-type="bs"></td>
                <td>${formatDateTime(record.date)}</td>
                <td>${record.value} ${record.unit}</td>
                <td>${getMeasurementTimeText(record.timing)}</td>
                <td><span class="status-indicator ${status.class}"><i class="${status.icon}"></i> ${status.text}</span></td>
                <td>${record.medication ? '是' : '否'}</td>`;
		});
	}
}

function updateLatestRecords() {
	// 血壓最新記錄
	const latestBp = bpRecords.length > 0 ? [...bpRecords].sort((a, b) => new Date(b.date) - new Date(a.date))[0] : null;
	if (latestBp) {
		const bpStatus = getBpStatus(latestBp.systolic, latestBp.diastolic);
		document.getElementById('latest-bp-sys').textContent = latestBp.systolic;
		document.getElementById('latest-bp-dia').textContent = latestBp.diastolic;
		document.getElementById('latest-bp-pulse').textContent = latestBp.pulse;
		document.getElementById('latest-bp-time').textContent = formatDateTime(latestBp.date);
		const statusElement = document.getElementById('bp-status-badge');
		statusElement.className = `badge bg-${bpStatus.class === 'normal' ? 'success' : bpStatus.class === 'warning' ? 'warning text-dark' : 'danger'}`;
		statusElement.textContent = bpStatus.text;
		document.getElementById('latest-bp-card').style.display = 'block';
	} else {
		document.getElementById('latest-bp-sys').textContent = '--';
		document.getElementById('latest-bp-dia').textContent = '--';
		document.getElementById('latest-bp-pulse').textContent = '--';
		document.getElementById('latest-bp-time').textContent = '--';
		document.getElementById('bp-status-badge').className = `badge bg-secondary`;
		document.getElementById('bp-status-badge').textContent = '未測量';
	}

	// 血糖最新記錄
	const latestBs = bsRecords.length > 0 ? [...bsRecords].sort((a, b) => new Date(b.date) - new Date(a.date))[0] : null;
	if (latestBs) {
		const bsStatus = getBsStatus(latestBs.value, latestBs.timing);
		document.getElementById('latest-bs-value').textContent = latestBs.value;
		document.getElementById('latest-bs-unit').textContent = latestBs.unit;
		document.getElementById('latest-bs-time-type').textContent = getMeasurementTimeText(latestBs.timing);
		document.getElementById('latest-bs-time').textContent = formatDateTime(latestBs.date);
		const statusElement = document.getElementById('bs-status-badge');
		statusElement.className = `badge bg-${bsStatus.class === 'normal' ? 'success' : bsStatus.class === 'warning' ? 'warning text-dark' : 'danger'}`;
		statusElement.textContent = bsStatus.text;
		document.getElementById('latest-bs-card').style.display = 'block';
	} else {
		document.getElementById('latest-bs-value').textContent = '--';
		document.getElementById('latest-bs-unit').textContent = 'mg/dL';
		document.getElementById('latest-bs-time-type').textContent = '--';
		document.getElementById('latest-bs-time').textContent = '--';
		document.getElementById('bs-status-badge').className = `badge bg-secondary`;
		document.getElementById('bs-status-badge').textContent = '未測量';
	}
}

function saveBpRecord(e) {
	e.preventDefault();
	const systolic = parseInt(document.getElementById('bp-systolic').value);
	const diastolic = parseInt(document.getElementById('bp-diastolic').value);
	const pulse = parseInt(document.getElementById('bp-pulse').value);
	const date = document.getElementById('bp-date').value;
	const medication = document.getElementById('bp-medication').checked;

	if (isNaN(systolic) || isNaN(diastolic) || isNaN(pulse) || !date) {
		Swal.fire({ icon: 'error', title: '資料錯誤', text: '請檢查所有血壓欄位是否都已填寫並為有效數值。', confirmButtonText: '確定' });
		return;
	}

	const newRecord = {
		date: new Date(date).toISOString(),
		systolic: systolic,
		diastolic: diastolic,
		pulse: pulse,
		medication: medication,
		armPosition: 'N/A'
	};

	bpRecords.push(newRecord);
	bpRecords.sort((a, b) => new Date(a.date) - new Date(b.date)); 
	saveRecords();
	updateHistoryTables();
	updateLatestRecords();

	e.target.reset();
    // 重設日期為當前時間
	document.getElementById('bp-date').value = new Date().toISOString().slice(0, 16);

	Swal.fire({ icon: 'success', title: '血壓記錄已新增', text: `${systolic}/${diastolic} mmHg 記錄成功！`, timer: 1500, showConfirmButton: false });
}

function saveBsRecord(e) {
	e.preventDefault();
	const value = parseInt(document.getElementById('bs-value').value);
	const timing = document.getElementById('bs-measurement-time').value;
	const date = document.getElementById('bs-date').value;
	const medication = document.getElementById('bs-medication').checked;

	if (isNaN(value) || !timing || !date) {
		Swal.fire({ icon: 'error', title: '資料錯誤', text: '請檢查所有血糖欄位是否都已填寫並為有效數值。', confirmButtonText: '確定' });
		return;
	}

	const newRecord = {
		date: new Date(date).toISOString(),
		value: value,
		unit: 'mg/dL', 
		timing: timing,
		medication: medication
	};

	bsRecords.push(newRecord);
	bsRecords.sort((a, b) => new Date(a.date) - new Date(b.date));
	saveRecords();
	updateHistoryTables();
	updateLatestRecords();

	e.target.reset();
    // 重設日期為當前時間
	document.getElementById('bs-date').value = new Date().toISOString().slice(0, 16);

	Swal.fire({ icon: 'success', title: '血糖記錄已新增', text: `${value} mg/dL 記錄成功！`, timer: 1500, showConfirmButton: false });
}

// **修正: 清空記錄並刷新 (Request 1)**
function savePatientInfo(event) {
	event.preventDefault();
	const name = document.getElementById('patient-name-input').value.trim();
	const birthYear = document.getElementById('patient-birth-year-input').value.trim();
	const gender = document.getElementById('patient-gender-input').value;
	const id = document.getElementById('patient-id-input').value.trim();
    
    // 檢查患者資訊是否完整
	if (!name || !birthYear || !id || gender === 'unknown') {
		Swal.fire({ icon: 'error', title: '資訊不完整', text: '請填寫姓名、ID、出生年份和性別。', confirmButtonText: '確定' });
		return;
	}

	// 更新患者資訊
	currentPatient.name[0].text = name;
	currentPatient.birthDate = birthYear + "-01-01";
	currentPatient.gender = gender;
	currentPatient.id = id;
	currentPatient.identifier[0].value = id;
	currentPatient.meta.lastUpdated = new Date().toISOString();

    // **清除所有記錄以符合新患者資訊要求 (Request 1)**
	bpRecords = [];
	bsRecords = [];
	saveRecords(); 

	localStorage.setItem('fhirPatient', JSON.stringify(currentPatient));

	updatePatientDisplay();
	updateHistoryTables(); 
	updateLatestRecords(); 

	Swal.fire({ 
		icon: 'success', 
		title: '患者資訊已保存', 
		html: '您的基本資料已成功更新並保存。<br><strong>血壓/血糖歷史記錄已重置。</strong>', 
		confirmButtonText: '確定' 
	}).then(() => {
		const patientModal = bootstrap.Modal.getInstance(document.getElementById('patientModal'));
		patientModal.hide();
	});
}

function populatePatientForm() {
	if (currentPatient.name && currentPatient.name[0]) {
		document.getElementById('patient-name-input').value = currentPatient.name[0].text;
	}
	if (currentPatient.birthDate) {
		const birthYear = currentPatient.birthDate.substring(0, 4);
		document.getElementById('patient-birth-year-input').value = birthYear;
	}
	const gender = currentPatient.gender || 'unknown';
	document.getElementById('patient-gender-input').value = gender;
	const idValue = (currentPatient.identifier && currentPatient.identifier.length > 0) ? currentPatient.identifier[0].value : currentPatient.id || '';
	document.getElementById('patient-id-input').value = idValue;
}

// **修正: 生成 FHIR 時檢查患者資訊並傳遞 type (Request 2)**
function generateFHIRFromHistory(type) {
	// 檢查患者資訊完整性
    if (!currentPatient.name[0] || currentPatient.name[0].text === '未設定姓名' || currentPatient.gender === 'unknown' || currentPatient.id === '未設定-1') {
        Swal.fire({ icon: 'error', title: '缺少患者資訊', text: '請先點擊「設定」按鈕，輸入並保存患者的姓名、ID、出生年份和性別。', confirmButtonText: '確定' });
		return;
    }

	const historyId = type === 'bp' ? 'bp-history' : 'bs-history';
	const recordsArray = type === 'bp' ? bpRecords : bsRecords;

	const selectedCheckboxes = document.querySelectorAll(`#${historyId} input[type="checkbox"]:checked`);

	let recordsToExport;
	let title;

	if (selectedCheckboxes.length > 0) {
		const selectedIndices = Array.from(selectedCheckboxes).map(cb => parseInt(cb.getAttribute('data-index')));
		recordsToExport = recordsArray.filter((_, index) => selectedIndices.includes(index));
		title = `急診救命護照 (${type === 'bp' ? '血壓' : '血糖'}) - ${selectedCheckboxes.length}筆`;
	} else {
		// 如果沒有選擇，則導出全部
		recordsToExport = recordsArray;
		title = `急診救命護照 (${type === 'bp' ? '血壓' : '血糖'}) - 全部 ${recordsToExport.length} 筆`;
	}
	
	if (recordsToExport.length === 0) {
		Swal.fire({ icon: 'warning', title: '無記錄可匯出', text: `請先新增${type === 'bp' ? '血壓' : '血糖'}記錄。`, confirmButtonText: '確定' });
		return;
	}

	const bundle = generateFHIRBundle(recordsToExport, type);

	// 顯示 FHIR Modal，並明確傳遞 type 參數
	showFHIRModal(bundle, title, type);
}

// 顯示 FHIR Bundle Modal
function showFHIRModal(resource, title, type) {
	const fhirModal = new bootstrap.Modal(document.getElementById('fhirModal'));
	document.getElementById('fhir-modal-title').textContent = title;

	// 格式化 JSON (無換行)
	const jsonStr = JSON.stringify(resource, null, 2); 
	document.getElementById('fhir-content-display').textContent = jsonStr;

	// 格式化文字報告 (應用不換行修正)
	const textReport = fhirToText(resource, type); // 使用傳入的 type
	document.getElementById('text-report-display').innerHTML = textReport; 

	// 更新 QR Code
	const jsonBase64 = btoa(jsonStr); // 將 JSON 轉換為 Base64
	const qrcodeContainer = document.getElementById('qrcode');
	qrcodeContainer.innerHTML = '';

	// 重新生成 QR Code
	qrcode = new QRCode(qrcodeContainer, {
		text: jsonBase64,
		width: 180,
		height: 180,
		colorDark: "#000000",
		colorLight: "#ffffff",
		correctLevel: QRCode.CorrectLevel.H
	});

	// 設定按鈕事件 (顯示切換)
	const textFormatBtn = document.getElementById('text-format-btn');
	const fhirFormatBtn = document.getElementById('fhir-format-btn');
	const textReportDisplay = document.getElementById('text-report-display');
	const fhirContentDisplay = document.getElementById('fhir-content-display');

	// 默認顯示文字報告
	textReportDisplay.classList.remove('d-none');
	fhirContentDisplay.classList.add('d-none');
	textFormatBtn.classList.remove('btn-outline-primary');
	textFormatBtn.classList.add('btn-primary');
	fhirFormatBtn.classList.add('btn-outline-primary');
	fhirFormatBtn.classList.remove('btn-primary');

	textFormatBtn.onclick = () => {
		textReportDisplay.classList.remove('d-none');
		fhirContentDisplay.classList.add('d-none');
		textFormatBtn.classList.remove('btn-outline-primary');
		textFormatBtn.classList.add('btn-primary');
		fhirFormatBtn.classList.add('btn-outline-primary');
		fhirFormatBtn.classList.remove('btn-primary');
	};

	fhirFormatBtn.onclick = () => {
		textReportDisplay.classList.add('d-none');
		fhirContentDisplay.classList.remove('d-none');
		fhirFormatBtn.classList.remove('btn-outline-primary');
		fhirFormatBtn.classList.add('btn-primary');
		textFormatBtn.classList.add('btn-outline-primary');
		textFormatBtn.classList.remove('btn-primary');
	};

	fhirModal.show();
}

// 複製 FHIR 內容
function copyFhirContent(elementId) {
	const fhirContent = document.getElementById(elementId).textContent;

	const textArea = document.createElement("textarea");
	textArea.value = fhirContent.replace(/<br>/g, '\r\n'); // 將 HTML 換行轉為真正的換行
	document.body.appendChild(textArea);
	textArea.focus();
	textArea.select();

	try {
		document.execCommand('copy');
		Swal.fire({ icon: 'info', title: '已複製', text: '內容已複製到剪貼簿。', timer: 1500, showConfirmButton: false });
	} catch (e) {
		Swal.fire({ icon: 'error', title: '複製失敗', text: '無法複製內容，請手動選取。', confirmButtonText: '確定' });
	}
	document.body.removeChild(textArea);
}

// 發送 Email 報告 (使用 generateFHIRFromHistory 中的 type)
function sendReportFromHistory(type) {
	const historyId = type === 'bp' ? 'bp-history' : 'bs-history';
	const recordsArray = type === 'bp' ? bpRecords : bsRecords;

	const selectedCheckboxes = document.querySelectorAll(`#${historyId} input[type="checkbox"]:checked`);
	const selectedIndices = Array.from(selectedCheckboxes).map(cb => parseInt(cb.getAttribute('data-index')));

	let recordsToExport;
	let title;

	if (selectedCheckboxes.length > 0) {
		recordsToExport = recordsArray.filter((_, index) => selectedIndices.includes(index));
		title = `${type === 'bp' ? '血壓' : '血糖'}歷史記錄報告 (${selectedCheckboxes.length}筆)`;
	} else {
		recordsToExport = recordsArray;
		title = `${type === 'bp' ? '血壓' : '血糖'}歷史記錄報告 (全部 ${recordsToExport.length} 筆)`;
	}

	if (recordsToExport.length === 0) {
		Swal.fire({ icon: 'warning', title: '無記錄可回傳', text: '請先新增記錄。', confirmButtonText: '確定' });
		return;
	}

	Swal.fire({
		title: '請輸入您的Gmail地址',
		input: 'email',
		inputLabel: '我們將使用 mailto 方式發送報告',
		inputPlaceholder: 'example@gmail.com',
		showCancelButton: true,
		confirmButtonText: '發送',
		cancelButtonText: '取消',
		inputValidator: (value) => {
			if (!value || !value.includes('@')) { return '請輸入有效的Gmail地址'; }
		}
	}).then((result) => {
		if (result.isConfirmed) {
			const email = result.value;
			const bundle = generateFHIRBundle(recordsToExport, type);
			const body = fhirToText(bundle, type).replace(/<br>/g, '\r\n').replace(/\|/g, '-'); 

			const mailtoLink = `mailto:${email}?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
			window.location.href = mailtoLink;

			Swal.fire({ icon: 'success', title: '報告已準備發送', text: '將開啟您的郵件客戶端。', timer: 2000, showConfirmButton: false });
		}
	});
}

// 頁面加載時執行
document.addEventListener('DOMContentLoaded', function() {
	loadRecords();
	initializePatient();
	updatePatientDisplay();
	updateHistoryTables();
	updateLatestRecords();

	// 設置表單提交事件
	document.getElementById('bp-form').addEventListener('submit', saveBpRecord);
	document.getElementById('bs-form').addEventListener('submit', saveBsRecord);
	document.getElementById('patient-info-form').addEventListener('submit', savePatientInfo); 

	// 設置當前日期時間為默認值
	const now = new Date();
	const formattedDateTime = now.toISOString().slice(0, 16);
	document.getElementById('bp-date').value = formattedDateTime;
	document.getElementById('bs-date').value = formattedDateTime;
	
	// 患者資訊模態視窗顯示時載入資料
	const patientModalElement = document.getElementById('patientModal');
	if (patientModalElement) {
		patientModalElement.addEventListener('show.bs.modal', populatePatientForm);
	}

	// 設置全選功能
	document.getElementById('select-all-bp').addEventListener('change', function() {
		const checkboxes = document.querySelectorAll('#bp-history input[type="checkbox"]');
		checkboxes.forEach(checkbox => {
			checkbox.checked = this.checked;
		});
	});
	document.getElementById('select-all-bs').addEventListener('change', function() {
		const checkboxes = document.querySelectorAll('#bs-history input[type="checkbox"]');
		checkboxes.forEach(checkbox => {
			checkbox.checked = this.checked;
		});
	});
});