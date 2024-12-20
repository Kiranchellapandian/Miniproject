# ml_model/app.py

from flask import Flask, request, jsonify
import joblib
import pandas as pd

app = Flask(__name__)

# Load the trained model
model = joblib.load('eta_random_forest_model.joblib')

@app.route('/predict-eta', methods=['POST'])
def predict_eta():
    data = request.get_json()

    # Extract features from the request
    distance = data.get('distance')
    hour = data.get('hour')
    day_of_week = data.get('day_of_week')
    traffic_condition = data.get('traffic_condition')  # e.g., 'heavy', 'light'
    bus_speed = data.get('bus_speed')

    # Create a DataFrame for prediction
    input_data = pd.DataFrame([{
        'distance': distance,
        'hour': hour,
        'day_of_week': day_of_week,
        'traffic_condition_heavy': 1 if traffic_condition == 'heavy' else 0,
        'traffic_condition_medium': 1 if traffic_condition == 'medium' else 0,
        # Add more conditions based on your model's features
        'bus_speed': bus_speed
    }])

    # Predict ETA
    eta = model.predict(input_data)[0]

    return jsonify({'eta': eta})

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000)
