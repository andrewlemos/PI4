/**
 * CLIMA.JS - AGROIRRIGA IOT
 * Integração Híbrida: Estação IoT Física (Firestore REST) + Complemento Meteorológico (Open-Meteo)
 */

// 1. Endpoint REST da sua Estação IoT no Google Firestore
const FIRESTORE_URL = 
  "https://firestore.googleapis.com/v1/projects/gen-lang-client-0853696923" +
  "/databases/ai-studio-remixagroirrigam-5a5bb94c-bad7-4521-b4d3-c959f2e7b3a6" +
  "/documents:runQuery?key=AIzaSyAafzTja9e_zsRTK3HfoI0hwXGcygbAQiE";

// Coordenadas padrão da sua fazenda/região (exemplo: São Paulo / Sul de Minas)
const LATITUDE_PADRAO = -22.9056;
const LONGITUDE_PADRAO = -47.0608;
const ALTITUDE_PADRAO = 680; // Altitude em metros (fundamental para ETo e pressão)

let moistureChart = null;

// Função auxiliar para decodificar os tipos do Firestore REST
function decodificarCampo(campo) {
  if (!campo) return null;
  if ("doubleValue" in campo) return Number(campo.doubleValue);
  if ("integerValue" in campo) return Number(campo.integerValue);
  if ("stringValue" in campo) return campo.stringValue;
  if ("booleanValue" in campo) return Boolean(campo.booleanValue);
  return campo;
}

// -----------------------------------------------------------------------------
// CÁLCULO OFICIAL DE EVAPOTRANSPIRAÇÃO FAO-56 PENMAN-MONTEITH
// -----------------------------------------------------------------------------
function calcularEtoFao56(temp, umid, ventoKmH, radiacaoWm2, altitudeM = 680, latitudeDeg = -22.9) {
  const tMean = temp;
  const u2 = Math.max(0.5, (ventoKmH / 3.6) * (4.87 / Math.log(67.8 * 10 - 5.42))); // Converte vento de 10m para 2m
  
  // Pressão atmosférica em kPa
  const p = 101.3 * Math.pow((293.0 - 0.0065 * altitudeM) / 293.0, 5.26);
  const gamma = 0.665e-3 * p;

  // Pressão de vapor de saturação (es) e atual (ea)
  const es = 0.6108 * Math.exp((17.27 * tMean) / (tMean + 237.3));
  const ea = (es * Math.max(1, Math.min(100, umid))) / 100.0;

  // Inclinação da curva de pressão de vapor (Delta)
  const delta = (4098.0 * es) / Math.pow(tMean + 237.3, 2);

  // Radiação solar extraterrestre (Ra)
  const agora = new Date();
  const inicioAno = new Date(agora.getFullYear(), 0, 0);
  const doy = Math.floor((agora - inicioAno) / 86400000);
  const latRad = (latitudeDeg * Math.PI) / 180.0;
  const dr = 1.0 + 0.033 * Math.cos((2.0 * Math.PI * doy) / 365.0);
  const deltaS = 0.409 * Math.sin((2.0 * Math.PI * doy) / 365.0 - 1.39);
  const tanProd = -Math.tan(latRad) * Math.tan(deltaS);
  const ws = Math.acos(Math.max(-1.0, Math.min(1.0, tanProd)));

  const ra = ((24.0 * 60.0) / Math.PI) * 0.082 * dr * 
             (ws * Math.sin(latRad) * Math.sin(deltaS) + Math.cos(latRad) * Math.cos(deltaS) * Math.sin(ws));

  // Radiação líquida estimada Rn (MJ/m²/dia)
  const rsMj = (radiacaoWm2 * 86400.0) / 1000000.0;
  const rns = (1.0 - 0.23) * rsMj;
  const rso = (0.75 + 2e-5 * altitudeM) * ra;
  const fCd = 1.35 * Math.min(1.0, rsMj / Math.max(0.1, rso)) - 0.35;
  const sigmaT4 = 4.903e-9 * Math.pow(tMean + 273.16, 4);
  const rnl = sigmaT4 * (0.34 - 0.14 * Math.sqrt(Math.max(0, ea))) * Math.max(0.05, fCd);
  const rn = Math.max(0, rns - rnl);

  // Equação FAO-56 Diária
  const num = 0.408 * delta * rn + gamma * (900.0 / (tMean + 273.0)) * u2 * (es - ea);
  const den = delta + gamma * (1.0 + 0.34 * u2);
  const eto = num / den;

  return Math.max(0.5, Math.min(12.0, Number(eto.toFixed(2))));
}

// -----------------------------------------------------------------------------
// 1. BUSCA DE DADOS DA ESTAÇÃO IOT (FIRESTORE)
// -----------------------------------------------------------------------------
async function buscarTelemetriaIoT() {
  const payload = {
    structuredQuery: {
      from: [{ collectionId: "telemetry" }],
      orderBy: [{ field: { fieldPath: "timestamp" }, direction: "DESCENDING" }],
      limit: 1
    }
  };

  try {
    const res = await fetch(FIRESTORE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!res.ok) throw new Error("Erro ao consultar Firestore");
    const data = await res.json();
    if (!data || !data[0] || !data[0].document) return null;

    const campos = data[0].document.fields || {};

    return {
      horario: decodificarCampo(campos.horaLeitura) || decodificarCampo(campos.createdAtIso),
      temperatura: decodificarCampo(campos.temp),
      umidade: decodificarCampo(campos.hum),
      pressao: decodificarCampo(campos.pabs),
      solo15cm: decodificarCampo(campos.soilSensor2), // Sonda 2 = 15 cm
      solo30cm: decodificarCampo(campos.soilSensor1) || decodificarCampo(campos.soil), // Sonda 1 = 30 cm
      chuva: decodificarCampo(campos.rain)
    };
  } catch (err) {
    console.warn("Falha ao obter telemetria IoT local:", err);
    return null;
  }
}

// -----------------------------------------------------------------------------
// 2. BUSCA DE DADOS COMPLEMENTARES EXTERNOS (OPEN-METEO)
// -----------------------------------------------------------------------------
async function buscarClimaExterno(lat = LATITUDE_PADRAO, lon = LONGITUDE_PADRAO) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,surface_pressure,wind_speed_10m,shortwave_radiation&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=auto`;
  
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error("Falha na API Open-Meteo");
    return await res.json();
  } catch (err) {
    console.error("Erro na API meteorológica:", err);
    return null;
  }
}

// -----------------------------------------------------------------------------
// 3. INICIALIZAÇÃO E ATUALIZAÇÃO DA INTERFACE
// -----------------------------------------------------------------------------
async function carregarDashboard() {
  const statusMsg = document.getElementById("status-message");
  
  // Busca em paralelo: Estação IoT e Satélite Meteorológico
  const [dadosIoT, dadosExternos] = await Promise.all([
    buscarTelemetriaIoT(),
    buscarClimaExterno()
  ]);

  // Valores Finais (Prioriza Estação IoT; Complementa com Externo)
  const tempFinal = dadosIoT?.temperatura ?? dadosExternos?.current?.temperature_2m ?? 25.0;
  const umidFinal = dadosIoT?.umidade ?? dadosExternos?.current?.relative_humidity_2m ?? 60.0;
  const pressaoFinal = dadosIoT?.pressao ?? dadosExternos?.current?.surface_pressure ?? 1013.2;
  const ventoKmH = dadosExternos?.current?.wind_speed_10m ?? 8.5;
  const radiacaoWm2 = dadosExternos?.current?.shortwave_radiation ?? 450.0;

  // Umidades de solo em 15 cm e 30 cm
  const solo15 = dadosIoT?.solo15cm != null ? Number(dadosIoT.solo15cm).toFixed(1) : "--";
  const solo30 = dadosIoT?.solo30cm != null ? Number(dadosIoT.solo30cm).toFixed(1) : "--";
  const mediaSolo = dadosIoT?.solo15cm != null ? Number(dadosIoT.solo15cm) : 0;

  // Chuva
  const chovendo = Boolean(dadosIoT?.chuva);

  // Calcula ETo FAO-56
  const eto = calcularEtoFao56(tempFinal, umidFinal, ventoKmH, radiacaoWm2, ALTITUDE_PADRAO, LATITUDE_PADRAO);

  // Preenche a Interface
  document.getElementById("temperature").textContent = Number(tempFinal).toFixed(1);
  document.getElementById("humidity").textContent = `${Number(umidFinal).toFixed(1)}%`;
  document.getElementById("pressure").textContent = `${Number(pressaoFinal).toFixed(1)} hPa`;
  document.getElementById("wind-speed").textContent = `${Number(ventoKmH).toFixed(1)} km/h`;
  document.getElementById("solar-radiation").textContent = `${Math.round(radiacaoWm2)} W/m²`;
  document.getElementById("eto-value").textContent = `${eto} mm/dia`;

  // Preenchimento dos dois sensores de solo
  document.getElementById("soil-15").textContent = `${solo15}%`;
  document.getElementById("soil-30").textContent = `${solo30}%`;

  // Precipitação (Estado Real do Sensor da Estação)
  const precEl = document.getElementById("precipitation");
  if (chovendo) {
    precEl.innerHTML = `<span style="color: #38bdf8;">🌧️ Chuva Detectada</span>`;
  } else {
    precEl.innerHTML = `<span style="color: #94a3b8;">☀️ Sem Chuva (Seco)</span>`;
  }

  // Horário e Cidade
  const dataHoje = new Date();
  document.getElementById("city-name").querySelector("span").textContent = "Estação de Campo (Fazenda)";
  document.getElementById("current-date").textContent = dadosIoT?.horario 
    ? `Leitura IoT: ${dadosIoT.horario}`
    : dataHoje.toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long" });

  document.getElementById("weather-description").textContent = chovendo ? "Chuva em andamento" : "Condição estável";
  document.getElementById("weather-icon").className = chovendo ? "ph ph-cloud-rain" : "ph ph-sun";

  // Avaliação do Manejo de Irrigação (Café / Solo Arenoso: Crítico = 8.8%, CC = 12.0%)
  const badgeEl = document.getElementById("irrigation-status-badge");
  if (mediaSolo <= 0.5) {
    badgeEl.textContent = "Sensor fora do solo (0%)";
    badgeEl.style.background = "#475569";
    badgeEl.style.color = "#fff";
  } else if (mediaSolo < 8.8) {
    badgeEl.textContent = "🚨 Irrigação Urgente (Abaixo de 8.8%)";
    badgeEl.style.background = "#ef4444";
    badgeEl.style.color = "#fff";
  } else if (mediaSolo < 12.0) {
    badgeEl.textContent = "💧 Atenção / Faixa de Consumo";
    badgeEl.style.background = "#eab308";
    badgeEl.style.color = "#000";
  } else {
    badgeEl.textContent = "✅ Solo em Capacidade de Campo";
    badgeEl.style.background = "#10b981";
    badgeEl.style.color = "#fff";
  }

  // Previsão dos Próximos Dias (Via API Externa)
  if (dadosExternos?.daily) {
    const forecastContainer = document.getElementById("forecast-container");
    forecastContainer.innerHTML = "";
    const times = dadosExternos.daily.time || [];
    const maxTemps = dadosExternos.daily.temperature_2m_max || [];
    const minTemps = dadosExternos.daily.temperature_2m_min || [];
    const precSums = dadosExternos.daily.precipitation_sum || [];

    times.slice(1, 5).forEach((dateStr, idx) => {
      const d = new Date(dateStr + "T00:00:00");
      const diaSemana = d.toLocaleDateString("pt-BR", { weekday: "short" });
      const card = document.createElement("div");
      card.className = "forecast-card";
      card.style = "background: #1e293b; padding: 10px; border-radius: 8px; text-align: center; min-width: 70px;";
      card.innerHTML = `
        <div style="font-size: 12px; color: #94a3b8; text-transform: uppercase;">${diaSemana}</div>
        <div style="font-size: 14px; font-weight: bold; margin: 4px 0;">${Math.round(maxTemps[idx + 1])}° / ${Math.round(minTemps[idx + 1])}°</div>
        <div style="font-size: 11px; color: #38bdf8;">🌧️ ${precSums[idx + 1]} mm</div>
      `;
      forecastContainer.appendChild(card);
    });
  }

  // Atualiza Gráfico de Tendência com as duas profundidades
  atualizarGraficoSolo(solo15, solo30);
}

// -----------------------------------------------------------------------------
// 4. GRÁFICO CHART.JS (15 cm vs 30 cm)
// -----------------------------------------------------------------------------
function atualizarGraficoSolo(s15, s30) {
  const canvas = document.getElementById("moisture-chart");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");

  const v15 = isNaN(s15) ? 0 : Number(s15);
  const v30 = isNaN(s30) ? 0 : Number(s30);

  if (moistureChart) {
    moistureChart.destroy();
  }

  moistureChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels: ["15 cm (Raiz Superficial)", "30 cm (Raiz Profunda)"],
      datasets: [
        {
          label: "Umidade Atual (%)",
          data: [v15, v30],
          backgroundColor: ["#10b981", "#3b82f6"],
          borderRadius: 6
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        y: {
          min: 0,
          max: 40,
          title: { display: true, text: "Umidade Volumétrica (%)", color: "#94a3b8" },
          grid: { color: "#334155" },
          ticks: { color: "#94a3b8" }
        },
        x: {
          ticks: { color: "#cbd5e1" },
          grid: { display: false }
        }
      },
      plugins: {
        legend: { display: false }
      }
    }
  });
}

// Inicializa quando a página carrega
document.addEventListener("DOMContentLoaded", carregarDashboard);