<?php
/*
Plugin Name: Woo LN Escrow for Dokan
Description: Integrates WooCommerce orders with a Lightning Network escrow service.
Version: 0.1.0
Author: OpenAI ChatGPT
*/

if ( ! defined( 'ABSPATH' ) ) {
    exit;
}

class Woo_LN_Escrow_Plugin {
    const OPTION_API_URL = 'woo_ln_escrow_api_url';
    const META_ESCROW_ID = '_woo_ln_escrow_id';
    const META_TOKEN = '_woo_ln_escrow_token';
    const META_QR = '_woo_ln_escrow_qr';
    const META_LIGHTNING_ADDRESS = '_woo_ln_lightning_address';
    const META_STATUS = '_woo_ln_escrow_status';

    public function __construct() {
        add_action( 'admin_menu', array( $this, 'add_settings_page' ) );
        add_action( 'admin_init', array( $this, 'register_settings' ) );
        add_filter( 'dokan_seller_meta_fields', array( $this, 'add_vendor_lightning_field' ) );
        add_action( 'dokan_process_seller_meta_fields', array( $this, 'save_vendor_lightning_field' ), 10, 2 );
        add_filter( 'dokan_get_dashboard_nav', array( $this, 'add_escrow_nav' ) );
        add_action( 'dokan_load_custom_template', array( $this, 'load_escrow_template' ) );
        add_filter( 'woocommerce_my_account_my_orders_actions', array( $this, 'add_escrow_actions' ), 10, 2 );
        add_action( 'template_redirect', array( $this, 'maybe_release_escrow' ) );
        add_action( 'wp_ajax_woo_ln_escrow_status', array( $this, 'ajax_update_status' ) );
        add_action( 'wp_ajax_nopriv_woo_ln_escrow_status', array( $this, 'ajax_update_status' ) );
    }

    public function add_settings_page() {
        add_options_page( 'Woo LN Escrow', 'Woo LN Escrow', 'manage_options', 'woo-ln-escrow', array( $this, 'render_settings_page' ) );
    }

    public function register_settings() {
        register_setting( 'woo_ln_escrow_options', self::OPTION_API_URL );
        add_settings_section( 'woo_ln_escrow_main', 'Escrow Settings', '__return_false', 'woo-ln-escrow' );
        add_settings_field( 'api_url', 'Escrow API URL', array( $this, 'render_api_url_field' ), 'woo-ln-escrow', 'woo_ln_escrow_main' );
    }

    public function render_api_url_field() {
        $val = esc_attr( get_option( self::OPTION_API_URL, '' ) );
        echo '<input type="text" name="' . self::OPTION_API_URL . '" value="' . $val . '" class="regular-text" />';
    }

    public function render_settings_page() {
        echo '<div class="wrap"><h1>Woo LN Escrow</h1><form method="post" action="options.php">';
        settings_fields( 'woo_ln_escrow_options' );
        do_settings_sections( 'woo-ln-escrow' );
        submit_button();
        echo '</form></div>';
    }

    public function add_vendor_lightning_field( $fields ) {
        $fields[ self::META_LIGHTNING_ADDRESS ] = array(
            'label' => __( 'Lightning Address', 'woo-ln-escrow' ),
            'type'  => 'text',
            'desc'  => __( 'Address to receive Lightning payouts.', 'woo-ln-escrow' ),
            'value' => get_user_meta( get_current_user_id(), self::META_LIGHTNING_ADDRESS, true ),
        );
        return $fields;
    }

    public function save_vendor_lightning_field( $store_id, $dokan_settings ) {
        if ( isset( $_POST[ self::META_LIGHTNING_ADDRESS ] ) ) {
            update_user_meta( $store_id, self::META_LIGHTNING_ADDRESS, sanitize_text_field( $_POST[ self::META_LIGHTNING_ADDRESS ] ) );
        }
    }

    public function add_escrow_nav( $urls ) {
        $urls['escrow-orders'] = array(
            'title' => __( 'Escrow Orders', 'woo-ln-escrow' ),
            'icon'  => '<i class="dashicons dashicons-lock"></i>',
            'url'   => dokan_get_navigation_url( 'escrow-orders' ),
            'pos'   => 55,
        );
        return $urls;
    }

    public function load_escrow_template( $query ) {
        if ( isset( $query->query_vars['escrow-orders'] ) ) {
            $this->render_escrow_orders_page();
            exit;
        }
    }

    private function render_escrow_orders_page() {
        if ( isset( $_POST['ship_escrow'], $_POST['order_id'] ) ) {
            $this->process_ship( intval( $_POST['order_id'] ) );
        } elseif ( isset( $_POST['dispute_escrow'], $_POST['order_id'] ) ) {
            $reason = isset( $_POST['reason'] ) ? sanitize_text_field( $_POST['reason'] ) : '';
            $this->process_dispute( intval( $_POST['order_id'] ), $reason );
        }

        $orders = wc_get_orders( array(
            'limit'      => -1,
            'meta_query' => array(
                array( 'key' => '_dokan_vendor_id', 'value' => get_current_user_id() ),
                array( 'key' => self::META_ESCROW_ID, 'compare' => 'EXISTS' ),
            ),
        ) );

        echo '<h2>' . esc_html__( 'Escrow Orders', 'woo-ln-escrow' ) . '</h2>';
        echo '<table class="widefat"><thead><tr><th>' . esc_html__( 'Order', 'woo-ln-escrow' ) . '</th><th>' . esc_html__( 'Status', 'woo-ln-escrow' ) . '</th><th>' . esc_html__( 'Actions', 'woo-ln-escrow' ) . '</th></tr></thead><tbody>';
        if ( $orders ) {
            foreach ( $orders as $order ) {
                $order_id = $order->get_id();
                $status   = get_post_meta( $order_id, self::META_STATUS, true );
                $escrow_id = get_post_meta( $order_id, self::META_ESCROW_ID, true );
                $api_url = get_option( self::OPTION_API_URL );
                if ( $escrow_id && $api_url ) {
                    $resp = wp_remote_get( trailingslashit( $api_url ) . 'api/escrow/' . $escrow_id );
                    if ( ! is_wp_error( $resp ) ) {
                        $data = json_decode( wp_remote_retrieve_body( $resp ), true );
                        if ( $data && isset( $data['status'] ) ) {
                            $status = sanitize_text_field( $data['status'] );
                            update_post_meta( $order_id, self::META_STATUS, $status );
                        }
                    }
                }
                echo '<tr><td>#' . esc_html( $order_id ) . '</td><td>' . esc_html( $status ) . '</td><td>';
                if ( 'awaiting_shipment' === $status ) {
                    echo '<form method="post" style="display:inline"><input type="hidden" name="order_id" value="' . esc_attr( $order_id ) . '" />';
                    submit_button( __( 'Mark Shipped', 'woo-ln-escrow' ), 'primary', 'ship_escrow', false );
                    echo '</form> ';
                }
                echo '<form method="post" style="display:inline"><input type="hidden" name="order_id" value="' . esc_attr( $order_id ) . '" />';
                echo '<input type="text" name="reason" placeholder="' . esc_attr__( 'Reason', 'woo-ln-escrow' ) . '" />';
                submit_button( __( 'Raise Dispute', 'woo-ln-escrow' ), 'secondary', 'dispute_escrow', false );
                echo '</form>';
                echo '</td></tr>';
            }
        } else {
            echo '<tr><td colspan="3">' . esc_html__( 'No escrow orders.', 'woo-ln-escrow' ) . '</td></tr>';
        }
        echo '</tbody></table>';
    }

    private function process_confirm( $order_id ) {
        $escrow_id = get_post_meta( $order_id, self::META_ESCROW_ID, true );
        $token     = get_post_meta( $order_id, self::META_TOKEN, true );
        $api_url   = get_option( self::OPTION_API_URL );
        if ( ! $escrow_id || ! $token || ! $api_url ) {
            return;
        }
        $response = wp_remote_post( trailingslashit( $api_url ) . 'api/escrow/' . $escrow_id . '/confirm', array(
            'headers' => array( 'Content-Type' => 'application/json' ),
            'body'    => wp_json_encode( array( 'token' => $token ) ),
            'timeout' => 45,
        ) );
        if ( ! is_wp_error( $response ) ) {
            update_post_meta( $order_id, self::META_STATUS, 'settled' );
        }
    }

    private function process_ship( $order_id ) {
        $escrow_id = get_post_meta( $order_id, self::META_ESCROW_ID, true );
        $token     = get_post_meta( $order_id, self::META_TOKEN, true );
        $api_url   = get_option( self::OPTION_API_URL );
        if ( ! $escrow_id || ! $token || ! $api_url ) {
            return;
        }
        $response = wp_remote_post( trailingslashit( $api_url ) . 'api/escrow/' . $escrow_id . '/ship', array(
            'headers' => array( 'Content-Type' => 'application/json' ),
            'body'    => wp_json_encode( array( 'token' => $token ) ),
            'timeout' => 45,
        ) );
        if ( ! is_wp_error( $response ) ) {
            update_post_meta( $order_id, self::META_STATUS, 'awaiting_release' );
        }
    }

    private function process_dispute( $order_id, $reason ) {
        $escrow_id = get_post_meta( $order_id, self::META_ESCROW_ID, true );
        $token     = get_post_meta( $order_id, self::META_TOKEN, true );
        $api_url   = get_option( self::OPTION_API_URL );
        if ( ! $escrow_id || ! $token || ! $api_url ) {
            return;
        }
        $response = wp_remote_post( trailingslashit( $api_url ) . 'api/escrow/' . $escrow_id . '/dispute', array(
            'headers' => array( 'Content-Type' => 'application/json' ),
            'body'    => wp_json_encode( array( 'token' => $token, 'reason' => $reason ) ),
            'timeout' => 45,
        ) );
        if ( ! is_wp_error( $response ) ) {
            update_post_meta( $order_id, self::META_STATUS, 'disputed' );
        }
    }

    public function add_escrow_actions( $actions, $order ) {
        $escrow_id = get_post_meta( $order->get_id(), self::META_ESCROW_ID, true );
        $token     = get_post_meta( $order->get_id(), self::META_TOKEN, true );
        $status    = get_post_meta( $order->get_id(), self::META_STATUS, true );
        $api_url   = get_option( self::OPTION_API_URL );

        if ( $escrow_id && $token && $api_url ) {
            $view_url = trailingslashit( $api_url ) . 'escrow/' . rawurlencode( $escrow_id ) . '/manage';
            $view_url = add_query_arg( 'token', rawurlencode( $token ), $view_url );
            $actions['view_escrow'] = array(
                'url'  => esc_url( $view_url ),
                'name' => __( 'View Escrow', 'woo-ln-escrow' ),
            );

            if ( 'awaiting_release' === $status ) {
                $release_url = wp_nonce_url(
                    add_query_arg( 'woo_ln_release', $order->get_id(), wc_get_account_endpoint_url( 'orders' ) ),
                    'woo_ln_release_' . $order->get_id()
                );
                $actions['woo_ln_release'] = array(
                    'url'  => esc_url( $release_url ),
                    'name' => __( 'Release Escrow', 'woo-ln-escrow' ),
                );
            }
        }

        return $actions;
    }

    public function ajax_update_status() {
        $order_id = isset( $_POST['order_id'] ) ? intval( $_POST['order_id'] ) : 0;
        $status   = isset( $_POST['status'] ) ? sanitize_text_field( $_POST['status'] ) : '';
        if ( ! $order_id || ! $status ) {
            wp_send_json_error();
        }
        update_post_meta( $order_id, self::META_STATUS, $status );
        wp_send_json_success();
    }

    public function maybe_release_escrow() {
        if ( isset( $_GET['woo_ln_release'], $_GET['_wpnonce'] ) ) {
            $order_id = intval( $_GET['woo_ln_release'] );
            if ( $order_id && wp_verify_nonce( $_GET['_wpnonce'], 'woo_ln_release_' . $order_id ) ) {
                $this->process_confirm( $order_id );
            }
            wp_safe_redirect( wc_get_account_endpoint_url( 'orders' ) );
            exit;
        }
    }

}

class Woo_LN_Escrow_Gateway extends WC_Payment_Gateway {
    public function __construct() {
        $this->id                 = 'woo_ln_escrow';
        $this->method_title       = __( 'Lightning Escrow', 'woo-ln-escrow' );
        $this->method_description = __( 'Pay using a Lightning Network escrow.', 'woo-ln-escrow' );
        $this->has_fields         = false;
        $this->supports           = array( 'products' );

        $this->init_form_fields();
        $this->init_settings();

        $this->title       = $this->get_option( 'title', __( 'Lightning Escrow', 'woo-ln-escrow' ) );
        $this->description = $this->get_option( 'description', __( 'Pay with Lightning held in escrow.', 'woo-ln-escrow' ) );

        add_action( 'woocommerce_update_options_payment_gateways_' . $this->id, array( $this, 'process_admin_options' ) );
    }

    public function init_form_fields() {
        $this->form_fields = array(
            'enabled'     => array(
                'title'   => __( 'Enable/Disable', 'woo-ln-escrow' ),
                'type'    => 'checkbox',
                'label'   => __( 'Enable Lightning Escrow', 'woo-ln-escrow' ),
                'default' => 'yes',
            ),
            'title'       => array(
                'title'       => __( 'Title', 'woo-ln-escrow' ),
                'type'        => 'text',
                'description' => __( 'Title shown at checkout.', 'woo-ln-escrow' ),
                'default'     => __( 'Lightning Escrow', 'woo-ln-escrow' ),
                'desc_tip'    => true,
            ),
            'description' => array(
                'title'       => __( 'Description', 'woo-ln-escrow' ),
                'type'        => 'textarea',
                'description' => __( 'Payment method description.', 'woo-ln-escrow' ),
                'default'     => __( 'Pay with Lightning; funds held in escrow until release.', 'woo-ln-escrow' ),
            ),
        );
    }

    public function process_payment( $order_id ) {
        $order = wc_get_order( $order_id );

        $api_url = get_option( Woo_LN_Escrow_Plugin::OPTION_API_URL );
        $seller_id = $order ? $order->get_meta( '_dokan_vendor_id' ) : 0;
        $lightning_address = $seller_id ? get_user_meta( $seller_id, Woo_LN_Escrow_Plugin::META_LIGHTNING_ADDRESS, true ) : '';

        if ( ! $api_url || ! $lightning_address ) {
            wc_add_notice( __( 'Escrow is not configured.', 'woo-ln-escrow' ), 'error' );
            return;
        }

        $body = array(
            'description'   => 'Order #' . $order_id,
            'amount'        => $order->get_total(),
            'sellerAddress' => $lightning_address,
        );

        $response = wp_remote_post( trailingslashit( $api_url ) . 'api/escrow', array(
            'headers' => array( 'Content-Type' => 'application/json' ),
            'body'    => wp_json_encode( $body ),
            'timeout' => 45,
        ) );

        if ( is_wp_error( $response ) ) {
            wc_add_notice( __( 'Failed to create escrow.', 'woo-ln-escrow' ), 'error' );
            return;
        }

        $data = json_decode( wp_remote_retrieve_body( $response ), true );
        if ( ! $data || empty( $data['hash'] ) || empty( $data['token'] ) ) {
            wc_add_notice( __( 'Invalid escrow response.', 'woo-ln-escrow' ), 'error' );
            return;
        }

        update_post_meta( $order_id, Woo_LN_Escrow_Plugin::META_ESCROW_ID, sanitize_text_field( $data['hash'] ) );
        update_post_meta( $order_id, Woo_LN_Escrow_Plugin::META_TOKEN, sanitize_text_field( $data['token'] ) );
        update_post_meta( $order_id, Woo_LN_Escrow_Plugin::META_STATUS, 'pending_payment' );
        if ( isset( $data['qr'] ) ) {
            update_post_meta( $order_id, Woo_LN_Escrow_Plugin::META_QR, $data['qr'] );
        }

        $redirect = trailingslashit( $api_url ) . 'escrow/' . rawurlencode( $data['hash'] );
        if ( ! empty( $data['token'] ) ) {
            $redirect .= '?token=' . rawurlencode( $data['token'] );
        }

        return array(
            'result'   => 'success',
            'redirect' => $redirect,
        );
    }
}

function woo_ln_escrow_add_gateway_class( $gateways ) {
    $gateways[] = 'Woo_LN_Escrow_Gateway';
    return $gateways;
}
add_filter( 'woocommerce_payment_gateways', 'woo_ln_escrow_add_gateway_class' );

new Woo_LN_Escrow_Plugin();

?>
