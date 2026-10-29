<?php
/**
 * Plugin Name: Insights Connector
 * Description: Lets the Insights SEO autopilot improve this site's SEO titles, meta descriptions, content and structured data, with every change logged and undoable from the app.
 * Version: 1.0.0
 * Requires at least: 5.6
 * Requires PHP: 7.4
 * License: GPLv2 or later
 *
 * How it works: activating the plugin creates a private connection key. "Connect
 * to Insights" (Settings > Insights) hands that key to the app once, and from then
 * on the app calls this site's REST API with it (namespace insights/v1). The app
 * can only read published posts and pages and change their SEO title, meta
 * description, content (it only appends marked sections) and structured data.
 * Deactivating the plugin cuts the connection.
 */

if (!defined('ABSPATH')) {
	exit;
}

const INSIGHTS_KEY_OPTION = 'insights_connector_key';
const INSIGHTS_APP_OPTION = 'insights_connector_app';
const INSIGHTS_SCHEMA_META = '_insights_schema';
const INSIGHTS_TITLE_META = '_insights_title';
const INSIGHTS_DESC_META = '_insights_description';
const INSIGHTS_DEFAULT_APP = 'https://br-weathered-mouse-b5ymo8mn-insights.compute.c-7.us-east-2.aws.neon.tech';

register_activation_hook(__FILE__, function () {
	if (!get_option(INSIGHTS_KEY_OPTION)) {
		update_option(INSIGHTS_KEY_OPTION, bin2hex(random_bytes(32)), false);
	}
});

/** Which SEO plugin owns titles and descriptions here, if any. */
function insights_seo_plugin() {
	if (defined('WPSEO_VERSION')) return 'yoast';
	if (class_exists('RankMath')) return 'rankmath';
	if (defined('SEOPRESS_VERSION')) return 'seopress';
	if (defined('AIOSEO_VERSION')) return 'aioseo';
	return 'none';
}

const INSIGHTS_META_KEYS = array(
	'yoast' => array('title' => '_yoast_wpseo_title', 'description' => '_yoast_wpseo_metadesc'),
	'rankmath' => array('title' => 'rank_math_title', 'description' => 'rank_math_description'),
	'seopress' => array('title' => '_seopress_titles_title', 'description' => '_seopress_titles_desc'),
	'none' => array('title' => INSIGHTS_TITLE_META, 'description' => INSIGHTS_DESC_META),
);

function insights_get_seo($post_id, $field) {
	$plugin = insights_seo_plugin();
	if ($plugin === 'aioseo' && class_exists('\AIOSEO\Plugin\Common\Models\Post')) {
		$row = \AIOSEO\Plugin\Common\Models\Post::getPost($post_id);
		$value = $field === 'title' ? $row->title : $row->description;
		return $value ? (string) $value : null;
	}
	$key = INSIGHTS_META_KEYS[$plugin === 'aioseo' ? 'none' : $plugin][$field];
	$value = get_post_meta($post_id, $key, true);
	return $value === '' ? null : (string) $value;
}

function insights_set_seo($post_id, $field, $value) {
	$plugin = insights_seo_plugin();
	if ($plugin === 'aioseo' && class_exists('\AIOSEO\Plugin\Common\Models\Post')) {
		$row = \AIOSEO\Plugin\Common\Models\Post::getPost($post_id);
		$row->post_id = $post_id;
		if ($field === 'title') $row->title = $value; else $row->description = $value;
		$row->save();
		return;
	}
	$key = INSIGHTS_META_KEYS[$plugin === 'aioseo' ? 'none' : $plugin][$field];
	if ($value === null || $value === '') delete_post_meta($post_id, $key);
	else update_post_meta($post_id, $key, wp_slash($value));
}

/** Without an SEO plugin, this plugin shows the titles and descriptions the app sets. */
add_filter('pre_get_document_title', function ($title) {
	if (insights_seo_plugin() !== 'none' || !is_singular()) return $title;
	$custom = get_post_meta(get_queried_object_id(), INSIGHTS_TITLE_META, true);
	return $custom !== '' ? $custom : $title;
}, 20);

add_action('wp_head', function () {
	if (!is_singular()) return;
	$id = get_queried_object_id();
	if (insights_seo_plugin() === 'none') {
		$desc = get_post_meta($id, INSIGHTS_DESC_META, true);
		if ($desc !== '') echo '<meta name="description" content="' . esc_attr($desc) . "\">\n";
	}
	// Structured data the app built from the page (JSON-LD script tags only).
	$schema = get_post_meta($id, INSIGHTS_SCHEMA_META, true);
	if ($schema !== '' && preg_match('#^\s*(?:<!--[^>]*-->\s*)?(<script type="application/ld\+json">[\s\S]*?</script>\s*)+(?:<!--[^>]*-->\s*)?$#', $schema)) {
		echo $schema . "\n";
	}
}, 5);

// ---------- the app's API ----------

function insights_authorized(WP_REST_Request $request) {
	$key = get_option(INSIGHTS_KEY_OPTION);
	$given = (string) $request->get_header('x-insights-key');
	return $key && $given !== '' && hash_equals($key, $given);
}

function insights_post($id) {
	$post = get_post((int) $id);
	if (!$post || !in_array($post->post_type, array('post', 'page'), true) || $post->post_status !== 'publish') {
		return new WP_Error('insights_not_found', 'No published post or page with that id.', array('status' => 404));
	}
	return $post;
}

function insights_item(WP_Post $post) {
	$author = get_userdata($post->post_author);
	return array(
		'id' => $post->ID,
		'type' => $post->post_type === 'post' ? 'article' : 'page',
		'url' => get_permalink($post),
		'title' => get_the_title($post),
		'content' => $post->post_content,
		'seo_title' => insights_get_seo($post->ID, 'title'),
		'seo_description' => insights_get_seo($post->ID, 'description'),
		'schema' => get_post_meta($post->ID, INSIGHTS_SCHEMA_META, true) ?: null,
		'published' => get_post_time('c', true, $post),
		'modified' => get_post_modified_time('c', true, $post),
		'author' => $author ? $author->display_name : null,
		'image' => get_the_post_thumbnail_url($post, 'full') ?: null,
	);
}

add_action('rest_api_init', function () {
	$auth = array('permission_callback' => 'insights_authorized');

	register_rest_route('insights/v1', '/hello', $auth + array(
		'methods' => 'GET',
		'callback' => function () {
			return array(
				'ok' => true,
				'name' => get_bloginfo('name'),
				'home' => home_url('/'),
				'seo_plugin' => insights_seo_plugin(),
				'version' => '1.0.0',
			);
		},
	));

	// The post or page behind a public address.
	register_rest_route('insights/v1', '/resolve', $auth + array(
		'methods' => 'GET',
		'callback' => function (WP_REST_Request $r) {
			$id = url_to_postid((string) $r->get_param('url'));
			if (!$id && untrailingslashit(home_url('/')) === untrailingslashit((string) $r->get_param('url'))) {
				$id = (int) get_option('page_on_front');
			}
			if (!$id) return new WP_Error('insights_not_found', 'That address is not a post or page.', array('status' => 404));
			$post = insights_post($id);
			return is_wp_error($post) ? $post : insights_item($post);
		},
	));

	// Published posts (or pages), newest first, 100 at a time.
	register_rest_route('insights/v1', '/items', $auth + array(
		'methods' => 'GET',
		'callback' => function (WP_REST_Request $r) {
			$type = $r->get_param('type') === 'page' ? 'page' : 'post';
			$posts = get_posts(array(
				'post_type' => $type,
				'post_status' => 'publish',
				'numberposts' => 100,
				'paged' => max(1, (int) $r->get_param('page')),
				'orderby' => 'date',
				'order' => 'DESC',
			));
			return array_map('insights_item', $posts);
		},
	));

	register_rest_route('insights/v1', '/item/(?P<id>\d+)', $auth + array(
		'methods' => 'GET',
		'callback' => function (WP_REST_Request $r) {
			$post = insights_post($r['id']);
			return is_wp_error($post) ? $post : insights_item($post);
		},
	));

	// SEO title and/or meta description; null clears it (the theme or SEO plugin default comes back).
	register_rest_route('insights/v1', '/seo/(?P<id>\d+)', $auth + array(
		'methods' => 'POST',
		'callback' => function (WP_REST_Request $r) {
			$post = insights_post($r['id']);
			if (is_wp_error($post)) return $post;
			$body = $r->get_json_params();
			foreach (array('title', 'description') as $field) {
				if (array_key_exists($field, $body)) {
					$value = $body[$field] === null ? null : sanitize_text_field((string) $body[$field]);
					insights_set_seo($post->ID, $field, $value);
				}
			}
			return insights_item(get_post($post->ID));
		},
	));

	// New content, only if nobody changed the post since the app read it.
	register_rest_route('insights/v1', '/content/(?P<id>\d+)', $auth + array(
		'methods' => 'POST',
		'callback' => function (WP_REST_Request $r) {
			$post = insights_post($r['id']);
			if (is_wp_error($post)) return $post;
			$body = $r->get_json_params();
			if (!isset($body['content'], $body['expected']) || md5($post->post_content) !== (string) $body['expected']) {
				return new WP_Error('insights_changed', 'The post changed since it was read.', array('status' => 409));
			}
			$result = wp_update_post(wp_slash(array('ID' => $post->ID, 'post_content' => (string) $body['content'])), true);
			return is_wp_error($result) ? $result : insights_item(get_post($post->ID));
		},
	));

	// Structured data shown in the page head; null removes it.
	register_rest_route('insights/v1', '/schema/(?P<id>\d+)', $auth + array(
		'methods' => 'POST',
		'callback' => function (WP_REST_Request $r) {
			$post = insights_post($r['id']);
			if (is_wp_error($post)) return $post;
			$body = $r->get_json_params();
			if (empty($body['schema'])) delete_post_meta($post->ID, INSIGHTS_SCHEMA_META);
			else update_post_meta($post->ID, INSIGHTS_SCHEMA_META, wp_slash((string) $body['schema']));
			return insights_item(get_post($post->ID));
		},
	));
});

// ---------- Settings > Insights ----------

add_action('admin_menu', function () {
	add_options_page('Insights', 'Insights', 'manage_options', 'insights-connector', 'insights_settings_page');
});

function insights_settings_page() {
	if (!current_user_can('manage_options')) return;
	if (!get_option(INSIGHTS_KEY_OPTION)) update_option(INSIGHTS_KEY_OPTION, bin2hex(random_bytes(32)), false);
	$app = untrailingslashit(get_option(INSIGHTS_APP_OPTION, INSIGHTS_DEFAULT_APP));
	$connect = add_query_arg(
		array(
			'site' => rawurlencode(home_url('/')),
			'key' => rawurlencode(get_option(INSIGHTS_KEY_OPTION)),
			'back' => rawurlencode(admin_url('options-general.php?page=insights-connector')),
		),
		$app . '/api/wordpress/connect'
	);
	$connected = isset($_GET['connected']);
	$error = isset($_GET['insights_error']) ? sanitize_text_field(wp_unslash($_GET['insights_error'])) : '';
	echo '<div class="wrap"><h1>Insights</h1>';
	if ($connected) echo '<div class="notice notice-success"><p>Connected. The SEO autopilot can now improve this site; every change is listed in the app and can be undone there.</p></div>';
	if ($error) echo '<div class="notice notice-error"><p>' . esc_html($error) . '</p></div>';
	echo '<p>Connect this site to your Insights account so the SEO autopilot can improve SEO titles, meta descriptions, content and structured data on your posts and pages.</p>';
	echo '<p>SEO plugin found: <strong>' . esc_html(insights_seo_plugin() === 'none' ? 'none (Insights shows titles and descriptions itself)' : insights_seo_plugin()) . '</strong></p>';
	echo '<p><a class="button button-primary button-hero" href="' . esc_url($connect) . '">' . ($connected ? 'Connect again' : 'Connect to Insights') . '</a></p>';
	echo '<p class="description">You will sign in to Insights if needed, then come right back here.</p></div>';
}
