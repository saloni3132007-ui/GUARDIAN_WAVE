#include <stdio.h>
#include <string.h>
#include <math.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/event_groups.h"
#include "esp_system.h"
#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_log.h"
#include "nvs_flash.h"
#include "driver/gpio.h"
#include "esp_websocket_client.h"
#include "esp_timer.h"

// Configuration
#define WIFI_SSID "qaer"
#define WIFI_PASS "plmoknijb"
#define WEBSOCKET_URI "ws://10.243.137.64:3000"

// Hardware Pins
#define PIR_PIN 4
#define BUZZER_PIN 5
#define BUTTON_PIN 7

// The Emitter MAC Address

const uint8_t EMITTER_MAC[6] = {0x90, 0x70, 0x69, 0x06, 0xF6, 0xA0};

static const char *TAG = "GUARDIAN_WAVE_BRAIN";
static EventGroupHandle_t s_wifi_event_group;
#define WIFI_CONNECTED_BIT BIT0

esp_websocket_client_handle_t ws_client;
bool alert_active = false;

volatile double current_csi_amplitude = 25.0;
portMUX_TYPE csi_mux = portMUX_INITIALIZER_UNLOCKED;

// CSI Callback (The Decibel & MAC-Filtered Radar)
static void csi_rx_cb(void *ctx, wifi_csi_info_t *info)
{
    if (!info || !info->buf || info->len == 0)
        return;

    if (info->rx_ctrl.rssi < -75)
        return;

    int8_t *mac_data = (int8_t *)info->buf;
    double total_amplitude = 0;
    int count = 0;

    for (int i = 0; i + 1 < info->len; i += 2)
    {
        int8_t i_val = mac_data[i];
        int8_t q_val = mac_data[i + 1];
        total_amplitude += sqrt((i_val * i_val) + (q_val * q_val));
        count++;
    }

    if (count > 0)
    {
        portENTER_CRITICAL(&csi_mux);
        current_csi_amplitude = total_amplitude / count;
        portEXIT_CRITICAL(&csi_mux);
    }
}

// WebSocket Event Handler
static void websocket_event_handler(void *handler_args, esp_event_base_t base, int32_t event_id, void *event_data)
{
    esp_websocket_event_data_t *data = (esp_websocket_event_data_t *)event_data;
    switch (event_id)
    {
    case WEBSOCKET_EVENT_CONNECTED:
        ESP_LOGI(TAG, "WEBSOCKET CONNECTED TO BACKEND");
        break;
    case WEBSOCKET_EVENT_DATA:
        if (data->data_len > 0 && strstr((char *)data->data_ptr, "TRIGGER_BUZZER") != NULL)
        {
            ESP_LOGW(TAG, "Fall detected by backend! Activating Buzzer.");
            gpio_set_level(BUZZER_PIN, 1);
            alert_active = true;
        }
        break;
    }
}

// WiFi Event Handler
static void wifi_event_handler(void *arg, esp_event_base_t event_base, int32_t event_id, void *event_data)
{
    if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_STA_START)
    {
        esp_wifi_connect();
    }
    else if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_STA_DISCONNECTED)
    {
        esp_wifi_connect();
        ESP_LOGI(TAG, "Retrying WiFi...");
    }
    else if (event_base == IP_EVENT && event_id == IP_EVENT_STA_GOT_IP)
    {
        ip_event_got_ip_t *event = (ip_event_got_ip_t *)event_data;
        ESP_LOGI(TAG, "Got IP: " IPSTR, IP2STR(&event->ip_info.ip));
        xEventGroupSetBits(s_wifi_event_group, WIFI_CONNECTED_BIT);
    }
}

// Hardware Init
void init_hardware()
{
    gpio_reset_pin(BUZZER_PIN);
    gpio_set_direction(BUZZER_PIN, GPIO_MODE_OUTPUT);
    gpio_set_level(BUZZER_PIN, 0);

    gpio_reset_pin(BUTTON_PIN);
    gpio_set_direction(BUTTON_PIN, GPIO_MODE_INPUT);
    gpio_set_pull_mode(BUTTON_PIN, GPIO_PULLUP_ONLY);

    gpio_reset_pin(PIR_PIN);
    gpio_set_direction(PIR_PIN, GPIO_MODE_INPUT);
    gpio_set_pull_mode(PIR_PIN, GPIO_PULLDOWN_ONLY);
}

// Main Application
void app_main(void)
{
    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND)
    {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ret = nvs_flash_init();
    }
    ESP_ERROR_CHECK(ret);

    init_hardware();

    s_wifi_event_group = xEventGroupCreate();
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();
    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));

    esp_event_handler_instance_register(WIFI_EVENT, ESP_EVENT_ANY_ID, &wifi_event_handler, NULL, NULL);
    esp_event_handler_instance_register(IP_EVENT, IP_EVENT_STA_GOT_IP, &wifi_event_handler, NULL, NULL);

    wifi_config_t wifi_config = {
        .sta = {.ssid = WIFI_SSID, .password = WIFI_PASS},
    };
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wifi_config));
    ESP_ERROR_CHECK(esp_wifi_start());

    xEventGroupWaitBits(s_wifi_event_group, WIFI_CONNECTED_BIT, pdFALSE, pdFALSE, portMAX_DELAY);

    // Initialize CSI Radar
    wifi_csi_config_t csi_config = {
        .lltf_en = true,
        .htltf_en = true,
        .stbc_htltf2_en = true,
        .ltf_merge_en = true,
        .channel_filter_en = true,
        .manu_scale = false,
        .shift = false,
    };
    ESP_ERROR_CHECK(esp_wifi_set_csi_config(&csi_config));
    ESP_ERROR_CHECK(esp_wifi_set_csi_rx_cb(csi_rx_cb, NULL));
    ESP_ERROR_CHECK(esp_wifi_set_csi(true));
    ESP_LOGI(TAG, "Dedicated Tripwire Radar Online!");

    // Initialize WebSocket
    esp_websocket_client_config_t websocket_cfg = {
        .uri = WEBSOCKET_URI,
    };
    ws_client = esp_websocket_client_init(&websocket_cfg);
    esp_websocket_register_events(ws_client, WEBSOCKET_EVENT_ANY, websocket_event_handler, (void *)ws_client);
    esp_websocket_client_start(ws_client);

    // Main Streaming Loop
    while (1)
    {
        int button_state = gpio_get_level(BUTTON_PIN);
        int pir_state = 0;

        // PIR 60-second warm-up bypass
        int64_t uptime_us = esp_timer_get_time();
        if (uptime_us > 60000000)
        {
            pir_state = gpio_get_level(PIR_PIN);
        }

        if (alert_active && button_state == 0)
        {
            gpio_set_level(BUZZER_PIN, 0);
            alert_active = false;

            if (esp_websocket_client_is_connected(ws_client))
            {
                char cancel_msg[] = "{\"event\": \"cancel_alert\"}";
                esp_websocket_client_send_text(ws_client, cancel_msg, strlen(cancel_msg), pdMS_TO_TICKS(200));
            }
            vTaskDelay(1000 / portTICK_PERIOD_MS);
        }

        if (esp_websocket_client_is_connected(ws_client))
        {
            double safe_amplitude;
            portENTER_CRITICAL(&csi_mux);
            safe_amplitude = current_csi_amplitude;
            portEXIT_CRITICAL(&csi_mux);

            char payload[128];
            snprintf(payload, sizeof(payload), "{\"event\": \"sensor_stream\", \"pir\": %d, \"amplitude\": %.2f}", pir_state, safe_amplitude);

            esp_websocket_client_send_text(ws_client, payload, strlen(payload), pdMS_TO_TICKS(200));
        }

        vTaskDelay(100 / portTICK_PERIOD_MS);
    }
}