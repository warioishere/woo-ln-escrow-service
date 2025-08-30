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
        add_action( 'admin_menu', array( $this, 'add_release_page' ) );
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

    public function create_escrow_invoice( $order_id, $posted_data, $order ) {
        $seller_id = $order->get_meta( '_dokan_vendor_id' );
        $lightning_address = get_user_meta( $seller_id, self::META_LIGHTNING_ADDRESS, true );
        $api_url = get_option( self::OPTION_API_URL );
        if ( ! $api_url || ! $lightning_address ) {
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
            return;
        }
        $data = json_decode( wp_remote_retrieve_body( $response ), true );
        if ( ! $data ) {
            return;
        }
        update_post_meta( $order_id, self::META_ESCROW_ID, $data['hash'] );
        update_post_meta( $order_id, self::META_TOKEN, $data['token'] );
        update_post_meta( $order_id, self::META_STATUS, 'pending' );
        if ( isset( $data['qr'] ) ) {
            update_post_meta( $order_id, self::META_QR, $data['qr'] );
        }
    }

    public function display_qr_on_thankyou( $order_id ) {
        $qr         = get_post_meta( $order_id, self::META_QR, true );
        $escrow_id  = get_post_meta( $order_id, self::META_ESCROW_ID, true );
        $api_url    = get_option( self::OPTION_API_URL );
        if ( $qr && $escrow_id && $api_url ) {
            echo '<h2>' . esc_html__( 'Pay with Lightning', 'woo-ln-escrow' ) . '</h2>';
            echo '<img id="woo-ln-escrow-qr" src="' . esc_attr( $qr ) . '" alt="Lightning Invoice" />';
            echo '<p id="woo-ln-escrow-status">' . esc_html__( 'Status: pending', 'woo-ln-escrow' ) . '</p>';
            $endpoint = esc_url_raw( trailingslashit( $api_url ) . 'api/escrow/' . $escrow_id );
            echo '<script>
            (function(){
                var s=document.getElementById("woo-ln-escrow-status");
                var img=document.getElementById("woo-ln-escrow-qr");
                async function poll(){
                    try{
                        const r=await fetch("' . esc_js( $endpoint ) . '");
                        if(!r.ok) return;
                        const d=await r.json();
                        s.textContent="Status: "+d.status;
                        if(d.status!=="pending"){ if(img) img.style.display="none"; clearInterval(i); }
                    }catch(e){}
                }
                var i=setInterval(poll,5000);
                poll();
            })();
            </script>';
        }
    }

    public function add_release_page() {
        add_menu_page( 'Escrow Release', 'Escrow Release', 'read', 'woo-ln-escrow-release', array( $this, 'render_release_page' ) );
    }

    public function render_release_page() {
        if ( isset( $_POST['order_id'] ) ) {
            $order_id   = intval( $_POST['order_id'] );
            $escrow_id  = get_post_meta( $order_id, self::META_ESCROW_ID, true );
            $token      = get_post_meta( $order_id, self::META_TOKEN, true );
            $order      = wc_get_order( $order_id );
            $seller_id  = $order ? $order->get_meta( '_dokan_vendor_id' ) : 0;
            $api_url    = get_option( self::OPTION_API_URL );
            if ( $order && $escrow_id && $token && $api_url && get_current_user_id() === intval( $seller_id ) ) {
                if ( isset( $_POST['raise_dispute'] ) ) {
                    $reason   = isset( $_POST['reason'] ) ? sanitize_text_field( $_POST['reason'] ) : '';
                    $response = wp_remote_post( trailingslashit( $api_url ) . 'api/escrow/' . $escrow_id . '/dispute', array(
                        'headers' => array( 'Content-Type' => 'application/json' ),
                        'body'    => wp_json_encode( array( 'token' => $token, 'reason' => $reason ) ),
                        'timeout' => 45,
                    ) );
                    if ( is_wp_error( $response ) ) {
                        echo '<div class="error"><p>' . esc_html__( 'Failed to raise dispute.', 'woo-ln-escrow' ) . '</p></div>';
                    } else {
                        update_post_meta( $order_id, self::META_STATUS, 'disputed' );
                        echo '<div class="updated"><p>' . esc_html__( 'Dispute raised.', 'woo-ln-escrow' ) . '</p></div>';
                    }
                } else {
                    $response = wp_remote_post( trailingslashit( $api_url ) . 'api/escrow/' . $escrow_id . '/confirm', array(
                        'headers' => array( 'Content-Type' => 'application/json' ),
                        'body'    => wp_json_encode( array( 'token' => $token ) ),
                        'timeout' => 45,
                    ) );
                    if ( is_wp_error( $response ) ) {
                        echo '<div class="error"><p>' . esc_html__( 'Failed to release escrow.', 'woo-ln-escrow' ) . '</p></div>';
                    } else {
                        update_post_meta( $order_id, self::META_STATUS, 'settled' );
                        echo '<div class="updated"><p>' . esc_html__( 'Escrow released.', 'woo-ln-escrow' ) . '</p></div>';
                    }
                }
                $status_resp = wp_remote_get( trailingslashit( $api_url ) . 'api/escrow/' . $escrow_id );
                if ( ! is_wp_error( $status_resp ) ) {
                    $status_data = json_decode( wp_remote_retrieve_body( $status_resp ), true );
                    if ( $status_data && isset( $status_data['status'] ) ) {
                        update_post_meta( $order_id, self::META_STATUS, sanitize_text_field( $status_data['status'] ) );
                    }
                }
            } else {
                echo '<div class="error"><p>' . esc_html__( 'Invalid order or permissions.', 'woo-ln-escrow' ) . '</p></div>';
            }
        }
        $current_status = '';
        if ( isset( $_POST['order_id'] ) ) {
            $current_status = get_post_meta( intval( $_POST['order_id'] ), self::META_STATUS, true );
        }
        echo '<div class="wrap"><h1>' . esc_html__( 'Escrow Actions', 'woo-ln-escrow' ) . '</h1>';
        if ( $current_status ) {
            echo '<p>' . esc_html__( 'Current status:', 'woo-ln-escrow' ) . ' ' . esc_html( $current_status ) . '</p>';
        }
        echo '<form method="post"><p><label>' . esc_html__( 'Order ID', 'woo-ln-escrow' ) . '</label> <input type="number" name="order_id" /></p>';
        echo '<p><label>' . esc_html__( 'Dispute reason', 'woo-ln-escrow' ) . '</label> <input type="text" name="reason" /></p>';
        submit_button( __( 'Release Payment', 'woo-ln-escrow' ), 'primary', 'release_payment', false );
        submit_button( __( 'Raise Dispute', 'woo-ln-escrow' ), 'secondary', 'raise_dispute', false );
        echo '</form></div>';
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
        update_post_meta( $order_id, Woo_LN_Escrow_Plugin::META_STATUS, 'pending' );
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
