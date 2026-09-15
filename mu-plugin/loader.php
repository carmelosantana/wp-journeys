<?php
/**
 * Plugin Name: wp-journeys agent
 * Description: Dev-only bridge for the wp-journeys runner. WordPress loads only top-level files in mu-plugins/, so this one file loads the agent directory mounted beside it. The agent refuses to serve unless explicitly enabled on a local/development site with WP_DEBUG on and a shared secret configured.
 */
require __DIR__ . '/wp-journeys-agent/wp-journeys-agent.php';
