// 初始化血壓和血糖記錄數組
let bpRecords = [];
let bsRecords = [];
let currentPatient = {}; // 用於儲存患者 FHIR 資源
let tesseractWorker = null; // OCR Worker 實例
let bpChartInstance = null;
let bsChartInstance = null;
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
		meta: {
			lastUpdated: new Date().toISOString()
		},
		text: {
			status: "generated",
			div: "<div xmlns=\"http://www.w3.org/1999/xhtml\">默認患者資料</div>"
		},
		identifier: [{
			use: "usual",
			type: {
				coding: [{
					system: "http://terminology.hl7.org/CodeSystem/v2-0203",
					code: "MR",
					display: "Medical Record Number"
				}]
			},
			system: "urn:oid:1.2.36.1.4.1.30008.2.1.1.1",
			value: "未設定-1"
		}],
		name: [{
			use: "usual",
			text: "未設定姓名"
		}],
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
				currentPatient.name = [{
					use: "usual",
					text: "未設定姓名"
				}];
			}
			// 確保 identifier 數組存在
			if (!currentPatient.identifier || currentPatient.identifier.length === 0) {
				currentPatient.identifier = [{
					use: "usual",
					value: currentPatient.id || "未設定-1"
				}];
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
	let status = {
		text: '正常', // 理想血壓 (< 120/80 mmHg)
		class: 'normal',
		icon: 'fas fa-check-circle'
	};
	// 1. 低血壓 (Hypotension: < 90/60 mmHg)
	if (systolic < 90 || diastolic < 60) {
		status = {
			text: '低',
			class: 'primary',
			icon: 'fas fa-info-circle'
		};
		// 2. 二級高血壓 (Stage 2 Hypertension: >= 140/90 mmHg)
	} else if (systolic >= 140 || diastolic >= 90) {
		status = {
			text: '高',
			class: 'danger',
			icon: 'fas fa-exclamation-triangle'
		};
		// 3. 一級高血壓 (Stage 1 Hypertension: >= 130/80 mmHg)
	} else if (systolic >= 130 || diastolic >= 80) {
		status = {
			text: '偏高',
			class: 'warning',
			icon: 'fas fa-exclamation-circle'
		};
		// 4. 高血壓前期 (Elevated Blood Pressure: 120-129 / < 80 mmHg)
		// 確保 DBP < 80 且 SBP 落在 120-129 之間
	} else if (systolic >= 120) {
		status = {
			text: '偏高', // 與一級高血壓使用相同文字
			class: 'warning',
			icon: 'fas fa-exclamation-circle'
		};
	}
	return status;
}
// 血糖狀態判斷
function getBsStatus(value, timing) {
	// 假設單位是 mg/dL
	let status = {
		text: '正常',
		class: 'normal',
		icon: 'fas fa-check-circle'
	};
	// 1. 低血糖 (Low Blood Sugar)
	if (value < 70) {
		status = {
			text: '偏低',
			class: 'warning',
			icon: 'fas fa-arrow-down'
		};
		return status;
	}
	if (timing === 'fasting') { // 空腹血糖標準
		if (value >= 126) {
			status = {
				text: '偏高',
				class: 'danger',
				icon: 'fas fa-exclamation-triangle'
			};
		} else if (value >= 100) {
			status = {
				text: '偏高',
				class: 'warning',
				icon: 'fas fa-exclamation-circle'
			};
		}
		// 正常值: 70 - 99
	} else if (timing === 'post-prandial') { // 飯後血糖標準
		if (value >= 200) {
			status = {
				text: '偏高',
				class: 'danger',
				icon: 'fas fa-exclamation-triangle'
			};
		} else if (value >= 140) {
			status = {
				text: '偏高',
				class: 'warning',
				icon: 'fas fa-exclamation-circle'
			};
		}
		// 正常值: < 140
	} else {
		// 其他時機 (如飯前、睡前、隨機)，使用較寬鬆的通用標準 (< 180 for warning, >= 200 for danger)
		if (value >= 200) {
			status = {
				text: '嚴重超標',
				class: 'danger',
				icon: 'fas fa-exclamation-triangle'
			};
		} else if (value >= 180) { // 假設其他時機的目標是 < 180
			status = {
				text: '偏高',
				class: 'warning',
				icon: 'fas fa-exclamation-circle'
			};
		}
		// 正常值: < 180
	}
	// 再次檢查低血糖，確保在所有分支中都已處理 (雖然已提前return)
	if (value < 70) {
		status = {
			text: '偏低',
			class: 'warning',
			icon: 'fas fa-arrow-down'
		};
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
// FHIR 資源生成 (修正與製作)
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
					coding: [{
						system: "http://loinc.org",
						code: "8480-6",
						display: "Systolic blood pressure"
					}],
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
					coding: [{
						system: "http://loinc.org",
						code: "8462-4",
						display: "Diastolic blood pressure"
					}],
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
					coding: [{
						system: "http://loinc.org",
						code: "8867-4",
						display: "Heart rate"
					}],
					text: "脈搏"
				},
				valueQuantity: {
					value: record.pulse,
					unit: "bpm",
					system: "http://unitsofmeasure.org",
					code: "/min"
				}
			}],
			note: record.medication ? [{
				text: "服藥：是"
			}] : []
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
			note: [{
				text: `時機: ${getMeasurementTimeText(record.timing)}`
			}].concat(record.medication ? [{
				text: "服藥：是"
			}] : [])
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
// 文字報告生成
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
			const bpStatusObj = getBpStatus(sysValue, diaValue);
			text += ` | 收縮壓(S): ${sysValue} mmHg | 舒張壓(D): ${diaValue} mmHg | 脈搏(P): ${pulseValue} bpm | 狀態: ${bpStatusObj.text}\r\n`;
		} else if (type === 'bs') {
			const value = observation.valueQuantity.value;
			const unit = observation.valueQuantity.unit;
			const timingText = observation.code.text;
			// --- 修正錯誤 B (邏輯錯誤): 根據中文時機文本，反推 getBsStatus 所需的英文 code ---
			// 1. 移除 "血糖" 得到純中文時機，例如 "空腹"
			const timingChinese = timingText.replace('血糖', '').trim();
			let timingCode = 'other'; // 默認值，對應 getBsStatus 中的 140 mg/dL
			// 2. 進行中文到英文代碼的映射
			if (timingChinese.includes('空腹')) {
				timingCode = 'fasting';
			} else if (timingChinese.includes('飯前')) {
				timingCode = 'before-meal';
			} else if (timingChinese.includes('飯後')) {
				timingCode = 'post-prandial';
			} else if (timingChinese.includes('睡前')) {
				timingCode = 'before-sleep'; // 雖然 getBsStatus 沒定義，但保留一致性
			}
			// -------------------------------------------------------------
			const bsStatusObj = getBsStatus(value, timingCode); // 傳入修正後的英文 code
			text += ` | 血糖值: ${value} ${unit} | 時機: ${timingText} | 狀態: ${bsStatusObj.text}`;
			const medicationNote = observation.note && observation.note.find(n => n.text.includes("服藥：是"));
			// 檢查並加入服藥資訊
			if (medicationNote) {
				text += ' | 服藥: 是';
			}
			text += '\r\n'; // 確保每次記錄換行
		}
	});
	return text.trim().replace(/\r\n/g, '<br>');
}
// **********************************************
// OCR 相關功能
// **********************************************
// 初始化 Tesseract Worker
async function getTesseractWorker() {
	if (!tesseractWorker) {
		Swal.fire({
			title: '載入辨識核心中...',
			text: '請稍候，此為初次啟動。',
			allowOutsideClick: false,
			didOpen: () => {
				Swal.showLoading();
			}
		});
		// 使用英文+繁體中文進行辨識
		tesseractWorker = await Tesseract.createWorker('eng+chi_tra');
		Swal.close();
	}
	return tesseractWorker;
}
// 解析 OCR 結果 (強化版)
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
		return {
			classifiedType: 'bs',
			values: values
		};
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
		return {
			classifiedType: 'bp',
			values: values
		};
	}
	// --- 3. 處理不匹配 (Mismatch & Failure) ---
	if (expectedType === 'bp' && matched && values.value) {
		Swal.fire({
			icon: 'warning',
			title: '⚠️ 數據不匹配',
			html: `系統識別到這是<strong>血糖數據 (${values.value})</strong>，但您正在<strong>血壓監測</strong>區塊。<br>請切換到正確的區塊再試一次。`,
			confirmButtonText: '確定'
		});
		return {
			classifiedType: 'mismatch',
			values: {}
		};
	}
	if (expectedType === 'bs' && bpMatched) {
		Swal.fire({
			icon: 'warning',
			title: '⚠️ 數據不匹配',
			html: `系統識別到這是<strong>血壓數據 (${systolic}/${diastolic})</strong>，但您正在<strong>血糖監測</strong>區塊。<br>請切換到正確的區塊再試一次。`,
			confirmButtonText: '確定'
		});
		return {
			classifiedType: 'mismatch',
			values: {}
		};
	}
	// 如果是血壓，但收縮壓或舒張壓任一缺失
	if (expectedType === 'bp' && (!systolic || !diastolic)) {
		return {
			classifiedType: 'bp_fail',
			values: {}
		};
	}
	// 如果是血糖，但數值缺失
	if (expectedType === 'bs' && !values.value) {
		return {
			classifiedType: 'bs_fail',
			values: {}
		};
	}
	return {
		classifiedType: 'fail',
		values: {}
	};
}
// 執行 OCR 辨識
async function handleOCR(type) {
	const fileInputId = type === 'bp' ? 'bp-image' : 'bs-image';
	const fileInput = document.getElementById(fileInputId);
	const imageFile = fileInput.files[0];
	if (!imageFile) {
		Swal.fire({
			icon: 'error',
			title: '未選擇圖片',
			text: '請先選擇血壓計/血糖儀的照片。',
			confirmButtonText: '確定'
		});
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
		const {
			data: {
				text
			}
		} = await worker.recognize(imageFile);
		// 2. 解析結果
		const result = parseOCRResult(text, type);
		const {
			classifiedType,
			values
		} = result;
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
			Swal.fire({
				icon: 'error',
				title: '辨識失敗',
				text: '無法從圖片中提取出有效數值。',
				confirmButtonText: '確定'
			});
		}
	} catch (error) {
		Swal.fire({
			icon: 'error',
			title: 'OCR 執行錯誤',
			text: '執行 OCR 辨識時發生錯誤，請檢查圖片或稍後再試。',
			confirmButtonText: '確定'
		});
		console.error('OCR Error:', error);
	}
}
// **********************************************
// 歷史記錄操作與顯示
// **********************************************
// 渲染血壓歷史記錄
function renderBpHistory() {
	const bpBody = document.getElementById('bp-history');
	bpBody.innerHTML = '';
	// 按照日期時間降序排列，最新在前
	const sortedBpRecords = [...bpRecords].sort((a, b) => new Date(b.date) - new Date(a.date));
	if (sortedBpRecords.length === 0) {
		bpBody.innerHTML = '<tr><td colspan="6" class="text-center text-muted py-3">尚無血壓記錄</td></tr>';
	} else {
		sortedBpRecords.forEach((record, index) => {
			// 找到原始索引，以便於後續的刪除或導出操作
			const originalIndex = bpRecords.findIndex(r => r === record);
			const row = bpBody.insertRow();
			const status = getBpStatus(record.systolic, record.diastolic);
			row.innerHTML = `
                <td><input type="checkbox" class="form-check-input" data-index="${originalIndex}" data-type="bp"></td>
                <td>${formatDateTime(record.date)}</td>
                <td>${record.systolic}/${record.diastolic} mmHg<br><span class="text-muted small"></span></td>
                <td><span class="status-indicator ${status.class}"><i class="${status.icon}"></i> ${status.text}</span></td>
                <td>${record.medication ? '是' : '否'}</td>
            `;
		});
	}
}
// 渲染血糖歷史記錄
function renderBsHistory() {
	const bsBody = document.getElementById('bs-history');
	bsBody.innerHTML = '';
	// 按照日期時間降序排列，最新在前
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
                <td>${record.medication ? '是' : '否'}</td>
            `;
		});
	}
}

function updateHistoryTables() {
	renderBpHistory();
	renderBsHistory();
	renderTrendCharts(); // <-- 新增：更新圖表趨勢
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
		document.getElementById('latest-bs-time-type').textContent = getMeasurementTimeText(latestBs.timing);
		document.getElementById('latest-bs-time').textContent = formatDateTime(latestBs.date);
		const statusElement = document.getElementById('bs-status-badge');
		statusElement.className = `badge bg-${bsStatus.class === 'normal' ? 'success' : bsStatus.class === 'warning' ? 'warning text-dark' : 'danger'}`;
		statusElement.textContent = bsStatus.text;
		document.getElementById('latest-bs-card').style.display = 'block';
	} else {
		document.getElementById('latest-bs-value').textContent = '--';
		document.getElementById('latest-bs-time-type').textContent = '--';
		document.getElementById('latest-bs-time').textContent = '--';
		document.getElementById('bs-status-badge').className = `badge bg-secondary`;
		document.getElementById('bs-status-badge').textContent = '未測量';
	}
}
// **********************************************
// 圖表趨勢顯示 (假設圖表庫已引入)
// **********************************************
function renderTrendCharts() {
	generateAndRenderRecommendations();
	const bpChartContainer = document.getElementById('bp-chart-container');
	const bsChartContainer = document.getElementById('bs-chart-container');
	if (!bpChartContainer || !bsChartContainer) return; // 避免元件未載入時報錯
	// 此處為圖表庫的實際繪製邏輯佔位
	if (bpRecords.length < 2) {
		bpChartContainer.innerHTML = '尚無足夠數據繪製血壓趨勢圖。';
	} else {
		// 假設：drawBpChart(bpRecords, bpChartContainer);
		bpChartContainer.innerHTML = '【圖表佔位】血壓趨勢圖表 (已找到 ' + bpRecords.length + ' 筆數據)';
	}
	if (bsRecords.length < 2) {
		bsChartContainer.innerHTML = '尚無足夠數據繪製血糖趨勢圖。';
	} else {
		// 假設：drawBsChart(bsRecords, bsChartContainer);
		bsChartContainer.innerHTML = '【圖表佔位】血糖趨勢圖表 (已找到 ' + bsRecords.length + ' 筆數據)';
	}
}
// 刪除選中的記錄
function deleteSelectedRecords(type) {
	const indicesToDelete = getSelectedRecords(type).sort((a, b) => b - a); // 降序排列，從後往前刪除
	if (indicesToDelete.length === 0) {
		Swal.fire({
			icon: 'warning',
			title: '未選擇記錄',
			text: `請先勾選要刪除的${type === 'bp' ? '血壓' : '血糖'}記錄。`,
			confirmButtonText: '確定'
		});
		return;
	}
	Swal.fire({
		title: '確認刪除?',
		text: `您確定要刪除選中的 ${indicesToDelete.length} 筆${type === 'bp' ? '血壓' : '血糖'}記錄嗎? 此操作無法復原。`,
		icon: 'warning',
		showCancelButton: true,
		confirmButtonColor: '#d33',
		cancelButtonColor: '#3085d6',
		confirmButtonText: '確認刪除',
		cancelButtonText: '取消'
	}).then((result) => {
		if (result.isConfirmed) {
			const records = type === 'bp' ? bpRecords : bsRecords;
			indicesToDelete.forEach(index => {
				records.splice(index, 1);
			});
			saveRecords();
			updateHistoryTables();
			updateLatestRecords();
			Swal.fire({
				icon: 'success',
				title: '刪除成功',
				text: `${indicesToDelete.length} 筆記錄已刪除。`,
				timer: 1500,
				showConfirmButton: false
			});
		}
	});
}
// 保存血壓記錄
function saveBpRecord(event) {
	event.preventDefault();
	const form = document.getElementById('bp-form');
	const date = form.elements['bp-date'].value;
	const systolic = form.elements['bp-systolic'].value;
	const diastolic = form.elements['bp-diastolic'].value;
	const pulse = form.elements['bp-pulse'].value;
	const medication = form.elements['bp-medication'].checked;
	// 假設手臂位置是用 radio input，name="bp-arm-position"
	const armPositionElement = form.querySelector('input[name="bp-arm-position"]:checked');
	const armPosition = armPositionElement ? armPositionElement.value : 'N/A';
	// 簡易驗證
	if (!date || !systolic || !diastolic || !pulse || isNaN(systolic) || isNaN(diastolic) || isNaN(pulse)) {
		Swal.fire('錯誤', '請檢查血壓、舒張壓和脈搏值是否為有效數字，以及所有欄位是否已填寫。', 'error');
		return;
	}
	// 建立記錄物件
	const newRecord = {
		date: new Date(date).toISOString(), // 標準化時間格式
		systolic: parseInt(systolic, 10),
		diastolic: parseInt(diastolic, 10),
		pulse: parseInt(pulse, 10),
		medication: medication,
		armPosition: armPosition
	};
	bpRecords.push(newRecord);
	saveRecords(); // 保存到 localStorage
	renderBpHistory(); // 更新歷史記錄表格
	renderTrendCharts(); // <--- 新增：保存後更新趨勢圖
	form.reset();
	// 重設日期時間為當前
	const now = new Date();
	form.elements['bp-date'].value = now.toISOString().slice(0, 16);
	Swal.fire('成功', '血壓紀錄已保存!', 'success');
}
// 保存血糖記錄
function saveBsRecord(e) {
	console.log('Attempting to save BS record...'); // <<< 診斷日誌
	e.preventDefault();
	const date = document.getElementById('bs-date').value;
	const value = parseFloat(document.getElementById('bs-value').value);
	const timing = document.getElementById('bs-timing').value; // 這行已在 HTML 中修復
	const medication = document.getElementById('bs-medication').checked;
	if (isNaN(value) || value <= 0 || !date || timing === 'N/A') {
		console.error('BS Save Validation Failed!'); // <<< 診斷日誌
		Swal.fire({
			icon: 'error',
			title: '資料錯誤',
			text: '請檢查所有血糖欄位是否都已填寫並為有效數值，尤其是測量時間和時機。',
			confirmButtonText: '確定'
		});
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
	// FIX: 重設表單後，必須重新將日期時間欄位設為預設值
	document.getElementById('bs-form').reset();
	document.getElementById('bs-date').value = new Date().toISOString().slice(0, 16); // 重新設定當前時間
	console.log('BS Record saved successfully. Displaying success alert.'); // <<< 診斷日誌
	Swal.fire({
		icon: 'success',
		title: '血糖記錄已新增',
		text: `${value} mg/dL 記錄成功！`,
		timer: 1500,
		showConfirmButton: false
	});
}
// **********************************************
// 患者資訊與顯示
// **********************************************
function updatePatientDisplay() {
	const patientName = currentPatient.name && currentPatient.name[0] ? currentPatient.name[0].text : '未設定姓名';
	const patientId = currentPatient.identifier && currentPatient.identifier[0] ? currentPatient.identifier[0].value : '無 ID';
	const patientGender = currentPatient.gender ? getGenderDisplay(currentPatient.gender) : '未知';
	const birthDate = currentPatient.birthDate || '1900-01-01';
	const birthYear = parseInt(birthDate.substring(0, 4));
	const currentYear = new Date().getFullYear();
	const age = (currentYear - birthYear > 0) ? currentYear - birthYear : 'N/A';
	document.getElementById('patient-name').textContent = patientName;
	document.getElementById('patient-id').textContent = patientId;
	document.getElementById('patient-gender-display').textContent = patientGender;
	document.getElementById('patient-age').textContent = age;
}

function savePatientInfo(event) {
	event.preventDefault();
	const name = document.getElementById('patient-name-input').value.trim();
	const birthYear = document.getElementById('patient-birth-year-input').value.trim();
	const gender = document.getElementById('patient-gender-input').value;
	const id = document.getElementById('patient-id-input').value.trim();
	// 檢查患者資訊是否完整
	if (!name || !birthYear || !id || gender === 'unknown') {
		Swal.fire({
			icon: 'error',
			title: '資訊不完整',
			text: '請填寫姓名、ID、出生年份和性別。',
			confirmButtonText: '確定'
		});
		return;
	}
	// 更新患者資訊
	currentPatient.name[0].text = name;
	currentPatient.birthDate = birthYear + "-01-01";
	currentPatient.gender = gender;
	currentPatient.id = id;
	// 確保 identifier 數組存在並更新
	if (!currentPatient.identifier || currentPatient.identifier.length === 0) {
		currentPatient.identifier = [{
			use: "usual",
			value: id
		}];
	} else {
		currentPatient.identifier[0].value = id;
	}
	currentPatient.meta.lastUpdated = new Date().toISOString();
	// **清除所有記錄以符合新患者資訊要求**
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
	if (currentPatient.name && currentPatient.name[0] && currentPatient.name[0].text !== '未設定姓名') {
		document.getElementById('patient-name-input').value = currentPatient.name[0].text;
	}
	if (currentPatient.identifier && currentPatient.identifier[0]) {
		document.getElementById('patient-id-input').value = currentPatient.identifier[0].value;
	}
	if (currentPatient.birthDate && currentPatient.birthDate !== '1900-01-01') {
		document.getElementById('patient-birth-year-input').value = currentPatient.birthDate.substring(0, 4);
	}
	if (currentPatient.gender && currentPatient.gender !== 'unknown') {
		document.getElementById('patient-gender-input').value = currentPatient.gender;
	}
}
// **********************************************
// 報告生成與導出
// **********************************************
// 輔助函數：獲取選中記錄的索引
function getSelectedRecords(type) {
	const tableId = type === 'bp' ? 'bp-history' : 'bs-history';
	// 選擇特定歷史記錄區塊中所有被選中的 checkbox
	const checkboxes = document.querySelectorAll(`#${tableId} input[type="checkbox"]:checked`);
	// 過濾掉全選按鈕 (其沒有 data-index 屬性)
	const recordCheckboxes = Array.from(checkboxes).filter(checkbox => checkbox.getAttribute('data-index') !== null);
	// 將 data-index 轉換為數字陣列
	return Array.from(recordCheckboxes).map(checkbox => parseInt(checkbox.getAttribute('data-index')));
}
// 生成歷史記錄的 FHIR 報告
function generateFHIRFromHistory(type) {
	// 1. 獲取選中的記錄
	const indices = getSelectedRecords(type);
	if (indices.length === 0) {
		Swal.fire({
			icon: 'warning',
			title: '未選擇記錄',
			text: `請先勾選要導出的${type === 'bp' ? '血壓' : '血糖'}記錄。`,
			confirmButtonText: '確定'
		});
		return;
	}
	// 2. 過濾記錄
	const records = type === 'bp' ? bpRecords : bsRecords;
	const recordsToExport = indices.map(index => records[index]);
	// 3. 檢查患者資訊是否完整
	if (!currentPatient.name[0] || currentPatient.name[0].text === "未設定姓名" || currentPatient.gender === "unknown" || currentPatient.birthDate === "1900-01-01" || !currentPatient.identifier[0] || currentPatient.identifier[0].value === "未設定-1") {
		Swal.fire({
			icon: 'error',
			title: '患者資訊缺失',
			html: '請先點擊右上角<strong>「設定」</strong>按鈕，填寫完整的患者資訊 (姓名、ID、出生年份、性別) 後再生成 FHIR 報告。',
			confirmButtonText: '確定'
		});
		return;
	}
	// 4. 生成 Bundle
	const title = `FHIR R4 報告 (${type === 'bp' ? '血壓' : '血糖'})`;
	const bundle = generateFHIRBundle(recordsToExport, type);
	// 5. 顯示 Modal
	showFHIRModal(bundle, title, type);
}
// 顯示 FHIR Bundle Modal
function showFHIRModal(resource, title, type) {
	const fhirModal = new bootstrap.Modal(document.getElementById('fhirModal'));
	document.getElementById('fhir-modal-title').textContent = title;
	// **↓↓↓ 修正 QR Code 狀態錯誤的核心代碼塊 (最終修訂 + 異步延遲) ↓↓↓**
	// 1. **優先清除全域變數**
	qrcode = null;
	const oldQrcodeContainer = document.getElementById('qrcode');
	if (oldQrcodeContainer) {
		const parentContainer = oldQrcodeContainer.parentElement;
		// 2. 徹底移除舊容器
		oldQrcodeContainer.remove();
		// 3. 創建一個全新的 QR Code 容器
		const newQrcodeContainer = document.createElement('div');
		newQrcodeContainer.id = 'qrcode';
		// 4. 將新容器放回 DOM
		parentContainer.appendChild(newQrcodeContainer);
		// -------------------------------------------------------------
		// 格式化 JSON (無換行)
		const jsonStr = JSON.stringify(resource, null, 2);
		document.getElementById('fhir-content-display').textContent = jsonStr;
		// 格式化文字報告
		const textReport = fhirToText(resource, type); // 使用傳入的 type
		document.getElementById('text-report-display').innerHTML = textReport;
		// 處理非 ASCII 字元以防止 btoa 錯誤 (InvalidCharacterError)
		const jsonBase64 = btoa(unescape(encodeURIComponent(jsonStr)));
		// 5. 引入異步延遲 (setTimeout(0))，確保舊的 QR Code 實例在 DOM 移除後有時間完全清理其內部狀態。
		// 這能避免 qrcode.min.js 的內部 race condition/狀態殘留問題。
		setTimeout(() => {
			// 6. 重新建立 QRCode 實例，使用**新容器**
			qrcode = new QRCode(newQrcodeContainer, {
				text: jsonBase64,
				width: 180,
				height: 180,
				colorDark: "#000000",
				colorLight: "#ffffff",
				correctLevel: QRCode.CorrectLevel.H
			});
		}, 0); // 這裡加入了異步延遲
	} else {
		console.error("QR Code 容器 (#qrcode) 元素未找到，無法生成 QR Code。");
	}
	// **↑↑↑ 修正 QR Code 狀態錯誤的核心代碼塊 (最終修訂 + 異步延遲) ↑↑↑**
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
// 複製內容到剪貼簿
function copyFhirContent(elementId) {
	const content = document.getElementById(elementId).tagName === 'PRE' ? document.getElementById(elementId).textContent : document.getElementById(elementId).innerText.replace(/\s+/g, ' ').trim(); // 處理 <br> 轉換成的文字
	navigator.clipboard.writeText(content).then(() => {
		Swal.fire({
			icon: 'success',
			title: '複製成功',
			text: '報告內容已複製到剪貼簿。',
			timer: 1500,
			showConfirmButton: false
		});
	}).catch(err => {
		console.error('複製失敗:', err);
		Swal.fire({
			icon: 'error',
			title: '複製失敗',
			text: '瀏覽器不支援或權限不足。',
			confirmButtonText: '確定'
		});
	});
}
// 將選中的歷史記錄發送到 Gmail
function sendReportFromHistory(type) {
	const indices = getSelectedRecords(type);
	if (indices.length === 0) {
		Swal.fire({
			icon: 'warning',
			title: '未選擇記錄',
			text: `請先勾選要導出的${type === 'bp' ? '血壓' : '血糖'}記錄。`,
			confirmButtonText: '確定'
		});
		return;
	}
	// 檢查患者資訊是否完整
	if (!currentPatient.name[0] || currentPatient.name[0].text === "未設定姓名" || currentPatient.gender === "unknown" || currentPatient.birthDate === "1900-01-01" || !currentPatient.identifier[0] || currentPatient.identifier[0].value === "未設定-1") {
		Swal.fire({
			icon: 'error',
			title: '患者資訊缺失',
			html: '請先點擊右上角<strong>「設定」</strong>按鈕，填寫完整的患者資訊 (姓名、ID、出生年份、性別) 後再發送報告。',
			confirmButtonText: '確定'
		});
		return;
	}
	// 1. 過濾記錄
	const records = type === 'bp' ? bpRecords : bsRecords;
	const recordsToExport = indices.map(index => records[index]);
	// 2. 生成 Bundle
	const bundle = generateFHIRBundle(recordsToExport, type);
	const title = `慢性病智慧系統 - ${type === 'bp' ? '血壓' : '血糖'} 歷史記錄報告 (${recordsToExport.length} 筆)`;
	// 3. 詢問用戶輸入 Gmail 地址
	Swal.fire({
		title: '請輸入收件人的 Gmail 地址',
		input: 'email',
		inputLabel: '報告將以純文字形式透過郵件客戶端發送',
		inputPlaceholder: 'example@gmail.com',
		showCancelButton: true,
		confirmButtonText: '發送',
		cancelButtonText: '取消',
		inputValidator: (value) => {
			if (!value) {
				return '請輸入有效的郵件地址';
			}
			if (!value.includes('@')) {
				return '請輸入有效的郵件地址';
			}
		}
	}).then((result) => {
		if (result.isConfirmed) {
			const email = result.value;
			// 4. 將 FHIR Bundle 轉換為郵件內文
			// 將 fhirToText 的 <br> 換回 \r\n，並將 | 換成 -，以優化郵件純文字格式
			const body = fhirToText(bundle, type).replace(/<br>/g, '\r\n').replace(/\|/g, '-');
			const mailtoLink = `mailto:${email}?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
			window.location.href = mailtoLink;
			Swal.fire({
				title: '準備發送郵件',
				html: `系統將開啟您的郵件客戶端<br>收件人: <strong>${email}</strong>`,
				confirmButtonText: '確定'
			});
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
	// 設置當前日期時間為默認值 (確保欄位有值，防止驗證失敗)
	const now = new Date();
	const formattedDateTime = now.toISOString().slice(0, 16);
	if (!document.getElementById('bp-date').value) {
		document.getElementById('bp-date').value = formattedDateTime;
	}
	if (!document.getElementById('bs-date').value) {
		document.getElementById('bs-date').value = formattedDateTime;
	}
	// 患者資訊模態視窗顯示時載入資料
	const patientModalElement = document.getElementById('patientModal');
	if (patientModalElement) {
		patientModalElement.addEventListener('show.bs.modal', populatePatientForm);
	}
	// 設置全選功能
	document.getElementById('select-all-bp').addEventListener('change', function() {
		const checkboxes = document.querySelectorAll('#bp-history input[type="checkbox"]');
		checkboxes.forEach(checkbox => {
			// 僅勾選有 data-index 的記錄行 checkbox，跳過表頭的 checkbox
			if (checkbox.getAttribute('data-index') !== null) {
				checkbox.checked = this.checked;
			}
		});
	});
	document.getElementById('select-all-bs').addEventListener('change', function() {
		const checkboxes = document.querySelectorAll('#bs-history input[type="checkbox"]');
		checkboxes.forEach(checkbox => {
			// 僅勾選有 data-index 的記錄行 checkbox
			if (checkbox.getAttribute('data-index') !== null) {
				checkbox.checked = this.checked;
			}
		});
	});
	const trendTab = document.getElementById('trend-tab');
	if (trendTab) {
		trendTab.addEventListener('click', function() {
			// 延遲渲染以確保標簽頁已完全顯示
			setTimeout(renderTrendCharts, 100);
			// 確保在點擊時生成建議
			setTimeout(generateAndRenderRecommendations, 200);
		});
	}
	// 確保在頁面加載時也嘗試渲染圖表和建議
	setTimeout(renderTrendCharts, 500);
	setTimeout(generateAndRenderRecommendations, 600);
});
// **********************************************
// 趨勢圖繪製
// **********************************************
function renderTrendCharts() {
	// 1. 繪製血壓圖表
	const bpCanvas = document.getElementById('bpChart');
	if (bpCanvas && typeof Chart !== 'undefined') {
		// 修正：確保數據按時間排序
		const sortedBpRecords = [...bpRecords].sort((a, b) => new Date(a.date) - new Date(b.date));
		const dates = sortedBpRecords.map(r => formatDateTime(new Date(r.date)));
		const systolicData = sortedBpRecords.map(r => r.systolic);
		const diastolicData = sortedBpRecords.map(r => r.diastolic);
		if (bpChartInstance) {
			bpChartInstance.destroy();
		}
		bpChartInstance = new Chart(bpCanvas.getContext('2d'), {
			type: 'line',
			data: {
				labels: dates,
				datasets: [{
					label: '收縮壓 (mmHg)',
					data: systolicData,
					borderColor: 'rgb(255, 99, 132)',
					backgroundColor: 'rgba(255, 99, 132, 0.5)',
					yAxisID: 'y'
				}, {
					label: '舒張壓 (mmHg)',
					data: diastolicData,
					borderColor: 'rgb(53, 162, 235)',
					backgroundColor: 'rgba(53, 162, 235, 0.5)',
					yAxisID: 'y'
				}]
			},
			options: {
				responsive: true,
				plugins: {
					title: {
						display: true,
						text: '血壓趨勢圖'
					}
				},
				scales: {
					y: {
						beginAtZero: false,
						title: {
							display: true,
							text: '壓力 (mmHg)'
						}
					}
				}
			}
		});
	}
	// 2. 繪製血糖圖表
	const bsCanvas = document.getElementById('bsChart');
	if (bsCanvas && typeof Chart !== 'undefined') {
		// 修正：確保數據按時間排序
		const sortedBsRecords = [...bsRecords].sort((a, b) => new Date(a.date) - new Date(b.date));
		const dates = sortedBsRecords.map(r => formatDateTime(new Date(r.date)));
		const bsValueData = sortedBsRecords.map(r => r.value);
		if (bsChartInstance) {
			bsChartInstance.destroy();
		}
		bsChartInstance = new Chart(bsCanvas.getContext('2d'), {
			type: 'line',
			data: {
				labels: dates,
				datasets: [{
					label: '血糖值 (mg/dL)',
					data: bsValueData,
					borderColor: 'rgb(75, 192, 192)',
					backgroundColor: 'rgba(75, 192, 192, 0.5)',
					yAxisID: 'y'
				}]
			},
			options: {
				responsive: true,
				plugins: {
					title: {
						display: true,
						text: '血糖趨勢圖'
					}
				},
				scales: {
					y: {
						beginAtZero: false,
						title: {
							display: true,
							text: '血糖 (mg/dL)'
						}
					}
				}
			}
		});
	}
}
// 修正：添加趨勢標簽點擊事件監聽
document.addEventListener('DOMContentLoaded', function() {
	// 原有的初始化代碼...
	// 添加趨勢標簽點擊事件
	const trendTab = document.getElementById('trend-tab');
	if (trendTab) {
		trendTab.addEventListener('click', function() {
			// 延遲渲染以確保標簽頁已完全顯示
			setTimeout(renderTrendCharts, 100);
		});
	}
	// 確保在頁面加載時也嘗試渲染圖表
	setTimeout(renderTrendCharts, 500);
});
// 修正：更新updateHistoryTables函數，確保包含圖表渲染
function updateHistoryTables() {
	renderBpHistory();
	renderBsHistory();
	renderTrendCharts(); // 確保更新數據時也更新圖表
}
/**
 * 建議物件的標準格式
 * @typedef {Object} Recommendation
 * @property {'danger' | 'warning' | 'info' | 'success'} level - 建議的緊急程度 (用於 Bootstrap class)。
 * @property {string} title - 建議標題。
 * @property {string} message - 建議的詳細內容。
 * @property {string} source - 建議來源 (e.g., '7日血糖平均分析')。
 */
// **請在 script_combined.js 中任何位置加入以下新函數**
/**
 * 計算指定天數內的平均值。
 * @param {Array<Object>} records - 血糖或血壓記錄。
 * @returns {Array<Object>} - 建議數組
 * @param {string} key - 要計算平均值的屬性 (e.g., 'value', 'systolic')。
 * @param {number} days - 往前追溯的天數。
 * @returns {number | null} 平均值，如果記錄不足則為 null。
 */
function calculateAverage(records, key, days = 7) {
	if (records.length === 0) return null;
	// 計算截止日期 (今天 - days 天)
	const cutoffDate = new Date();
	cutoffDate.setDate(cutoffDate.getDate() - days);
	const recentRecords = records.filter(r => new Date(r.date) >= cutoffDate).map(r => r[key]);
	if (recentRecords.length === 0) return null;
	const sum = recentRecords.reduce((acc, val) => acc + val, 0);
	return sum / recentRecords.length;
}
// **請在 script_combined.js 中任何位置加入以下新函數**
/**
 * 分析血糖記錄並產生建議。
 * @param {Array<Object>} bsRecords - 血糖記錄數組。
 * @returns {Array<Recommendation>} 血糖相關建議列表。
 */
function analyzeBs(records) {
	const recommendations = [];
	// 獲取近 7 日的記錄
	const sevenDaysAgo = new Date();
	sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
	const recentRecords = records.filter(r => new Date(r.date) >= sevenDaysAgo);
	if (recentRecords.length === 0) return recommendations;
	// 分類並計算平均值
	const categorized = {
		fasting: [],
		post_prandial: [],
		other: []
	};
	recentRecords.forEach(r => {
		if (r.timing === 'fasting') {
			categorized.fasting.push(r.value);
		} else if (r.timing === 'post-prandial') {
			categorized.post_prandial.push(r.value);
		} else {
			categorized.other.push(r.value);
		}
	});
	// --- 1. 空腹血糖分析 ---
	if (categorized.fasting.length > 0) {
		const avgFast = categorized.fasting.reduce((a, b) => a + b, 0) / categorized.fasting.length;
		if (avgFast >= 126) { // 糖尿病標準
			recommendations.push({
				level: 'danger',
				title: '🚨 空腹血糖平均值過高',
				message: `近7日平均空腹血糖為 ${avgFast.toFixed(0)} mg/dL。數值已達糖尿病診斷門檻 (>=126 mg/dL)。請立即就醫檢查。`,
				source: '7日平均分析'
			});
		} else if (avgFast >= 100) { // 糖尿病前期標準
			recommendations.push({
				level: 'warning',
				title: '⚠️ 空腹血糖偏高 (糖尿病前期)',
				message: `近7日平均空腹血糖為 ${avgFast.toFixed(0)} mg/dL。建議諮詢醫護人員並加強飲食及運動控制。`,
				source: '7日平均分析'
			});
		}
		if (avgFast < 70) { // 低血糖
			recommendations.push({
				level: 'warning',
				title: '⚠️ 空腹血糖平均值偏低',
				message: `近7日平均空腹血糖為 ${avgFast.toFixed(0)} mg/dL。請注意低血糖風險。`,
				source: '7日平均分析'
			});
		}
	}
	// --- 2. 飯後血糖分析 ---
	if (categorized.post_prandial.length > 0) {
		const avgPost = categorized.post_prandial.reduce((a, b) => a + b, 0) / categorized.post_prandial.length;
		if (avgPost >= 200) { // 糖尿病標準
			recommendations.push({
				level: 'danger',
				title: '🚨 飯後血糖平均值過高',
				message: `近7日平均飯後血糖為 ${avgPost.toFixed(0)} mg/dL。數值已達糖尿病診斷門檻 (>=200 mg/dL)。請立即就醫檢查。`,
				source: '7日平均分析'
			});
		} else if (avgPost >= 140) { // 糖尿病前期標準
			recommendations.push({
				level: 'warning',
				title: '⚠️ 飯後血糖偏高 (糖尿病前期)',
				message: `近7日平均飯後血糖為 ${avgPost.toFixed(0)} mg/dL。建議諮詢醫護人員並調整飲食習慣。`,
				source: '7日平均分析'
			});
		}
	}
	// --- 3. 其他時機的低血糖警示 (如 before-meal, before-sleep) ---
	// 這裡只檢查是否有頻繁的低血糖發生
	if (categorized.other.length > 0) {
		const lowCount = categorized.other.filter(v => v < 70).length;
		if (lowCount > 1) { // 過去 7 天內有兩次以上低血糖，視為風險
			recommendations.push({
				level: 'warning',
				title: '⚠️ 注意低血糖風險',
				message: `近7日有 ${lowCount} 次非空腹時段血糖值低於 70 mg/dL。請諮詢醫師是否需要調整藥物。`,
				source: '7日平均分析'
			});
		}
	}
	return recommendations;
}
// 由於您的範例是健康數據，我們將把血壓分析也列入考量
/**
 * 分析血壓記錄並產生建議。
 * @param {Array<Object>} bpRecords - 血壓記錄數組。
 * @returns {Array<Recommendation>} 血壓相關建議列表。
 */
function analyzeBp(bpRecords) {
	const recommendations = [];
	const sortedRecords = [...bpRecords].sort((a, b) => new Date(a.date) - new Date(b.date));
	// 1. 7日平均血壓分析 (標準 < 120/80 mmHg)
	const recentBp = sortedRecords.slice(-7).filter(r => r.systolic);
	if (recentBp.length >= 3) {
		const avgSys = calculateAverage(recentBp, 'systolic', 7);
		const avgDia = calculateAverage(recentBp, 'diastolic', 7);
		if (avgSys > 140 || avgDia > 90) {
			recommendations.push({
				level: 'danger',
				title: '🚨 血壓嚴重偏高 (二級高血壓)',
				message: `近7日平均血壓為 ${avgSys.toFixed(0)}/${avgDia.toFixed(0)} mmHg。請立即尋求醫療協助或調整藥物。`,
				source: '7日平均分析'
			});
		} else if (avgSys >= 130 || avgDia >= 80) {
			recommendations.push({
				level: 'warning',
				title: '⚠️ 血壓偏高 (一級高血壓或高血壓前期)',
				message: `近7日平均血壓為 ${avgSys.toFixed(0)}/${avgDia.toFixed(0)} mmHg。建議低鈉飲食，規律運動。`,
				source: '7日平均分析'
			});
		}
	}
	return recommendations;
}
/**
 * 整合所有分析結果並渲染到 UI 上。
 */
function generateAndRenderRecommendations() {
	const bsRecommendations = analyzeBs(bsRecords);
	const bpRecommendations = analyzeBp(bpRecords);
	const allRecommendations = [...bsRecommendations, ...bpRecommendations];
	const container = document.getElementById('recommendations-container');
	if (!container) return; // 確保容器存在
	if (allRecommendations.length === 0) {
		container.innerHTML = `<div class="alert alert-success mt-3"><i class="fas fa-check-circle me-2"></i>恭喜！您的健康數據趨勢穩定且達標，請繼續保持。</div>`;
		return;
	}
	// 渲染所有建議
	container.innerHTML = allRecommendations.map(rec => `
        <div class="alert alert-${rec.level} alert-dismissible fade show mb-3" role="alert">
            <h5 class="alert-heading">${rec.title} <span class="badge bg-secondary ms-2">${rec.source}</span></h5>
            <p class="mb-0">${rec.message}</p>
            <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>
        </div>
    `).join('');
}