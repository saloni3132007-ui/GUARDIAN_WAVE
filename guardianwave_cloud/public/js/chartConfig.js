(function () {
  "use strict";

  var MAX_POINTS = 40;

  if (typeof Chart === "undefined") {
    console.error("[GuardianWave] Chart.js did not load.");
    return;
  }

  function makeLineChart(canvasId, color) {
    var canvas = document.getElementById(canvasId);
    if (!canvas) return null;

    // Initialize with an array of zeros so it draws a flat line immediately
    var initialData = Array(MAX_POINTS).fill(0);
    var initialLabels = Array.from({ length: MAX_POINTS }, () => "");

    return new Chart(canvas.getContext("2d"), {
      type: "line",
      data: {
        labels: initialLabels,
        datasets: [
          {
            data: initialData,
            borderColor: color,
            borderWidth: 2,
            pointRadius: 0,
            tension: 0.35,
            fill: false,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 0 }, // Disable animation to keep the live feed super fast and crisp
        interaction: { intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: { enabled: false },
        },
        scales: {
          x: { display: false },
          y: { display: false, min: 0 }, // Base the graph bottom at 0
        },
      },
    });
  }

  var csiChart = makeLineChart("csiChart", "#E8A33D");

  window.GuardianWave = window.GuardianWave || {};
  window.GuardianWave.charts = { csi: csiChart };

  function pushPoint(chart, value) {
    if (!chart) return;

    var data = chart.data.datasets[0].data;
    var labels = chart.data.labels;

    labels.push("");
    data.push(value);

    if (data.length > MAX_POINTS) {
      data.shift();
      labels.shift();
    }

    chart.update("none");
  }

  function extractValue(payload) {
    if (payload && typeof payload === "object" && "value" in payload)
      return payload.value;
    if (typeof payload === "number") return payload;
    return null;
  }

  window.GuardianWave.on("csiVariance", function (payload) {
    var value = extractValue(payload);
    if (value === null) return;
    pushPoint(csiChart, value);
  });
})();
