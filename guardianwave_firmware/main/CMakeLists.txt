idf_component_register(SRCS "main.c"
                       INCLUDE_DIRS "."
                       REQUIRES esp_websocket_client esp_wifi esp_event esp_netif nvs_flash esp_driver_gpio)